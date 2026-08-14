import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { codexWakeAdapter, executableWakeAdapter } from "../cli/wake-adapters.js";
import type { WakeEvent } from "../client/listener.js";

const temporaryDirectories: string[] = [];
const event: WakeEvent = {
  localSessionId: "s_0123456789abcdef01234567",
  roomId: "0123456789abcdef0123456789abcdef",
  role: "guest",
  afterCursor: 4,
  throughCursor: 7,
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function executable(body: string): Promise<{ path: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "get-a-room-adapter-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "adapter.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`, "utf8");
  await chmod(path, 0o700);
  return { path, directory };
}

describe("wake adapters", () => {
  it("passes only activity metadata to a generic executable", async () => {
    const fixture = await executable("");
    const capture = join(fixture.directory, "event.json");
    await writeFile(fixture.path, `#!/usr/bin/env node
      import { writeFile } from "node:fs/promises";
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      await writeFile(${JSON.stringify(capture)}, Buffer.concat(chunks));
    `, "utf8");
    await chmod(fixture.path, 0o700);

    await expect(executableWakeAdapter(fixture.path).wake(event)).resolves.toBe("accepted");
    expect(JSON.parse(await readFile(capture, "utf8"))).toEqual(event);
  });

  it("maps exit code 75 to busy", async () => {
    const fixture = await executable("process.stdin.resume(); process.stdin.on('end', () => process.exit(75));");
    await expect(executableWakeAdapter(fixture.path).wake(event)).resolves.toBe("busy");
  });

  it("passes only allowlisted runtime paths to the child environment", async () => {
    const fixture = await executable("");
    const capture = join(fixture.directory, "env.json");
    await writeFile(fixture.path, `#!/usr/bin/env node
      import { writeFile } from "node:fs/promises";
      process.stdin.resume();
      process.stdin.on("end", async () => {
        await writeFile(${JSON.stringify(capture)}, JSON.stringify({
          invitation: process.env.GET_A_ROOM_INVITATION,
          invite: process.env.ROOM_INVITE,
          creator: process.env.ROOM_CREATOR_KEY,
          signing: process.env.ROOM_SIGNING_SECRET,
          unrelated: process.env.UNRELATED_API_TOKEN,
          path: process.env.PATH,
          roomHome: process.env.GET_A_ROOM_HOME
        }));
      });
    `, "utf8");
    await chmod(fixture.path, 0o700);
    const previous = {
      invitation: process.env.GET_A_ROOM_INVITATION,
      invite: process.env.ROOM_INVITE,
      creator: process.env.ROOM_CREATOR_KEY,
      signing: process.env.ROOM_SIGNING_SECRET,
      unrelated: process.env.UNRELATED_API_TOKEN,
      roomHome: process.env.GET_A_ROOM_HOME,
    };
    process.env.GET_A_ROOM_INVITATION = "invitation-secret";
    process.env.ROOM_INVITE = "room-secret";
    process.env.ROOM_CREATOR_KEY = "creator-secret";
    process.env.ROOM_SIGNING_SECRET = "signing-secret";
    process.env.UNRELATED_API_TOKEN = "unrelated-secret";
    process.env.GET_A_ROOM_HOME = fixture.directory;
    try {
      await expect(executableWakeAdapter(fixture.path).wake(event)).resolves.toBe("accepted");
    } finally {
      restoreEnvironment("GET_A_ROOM_INVITATION", previous.invitation);
      restoreEnvironment("ROOM_INVITE", previous.invite);
      restoreEnvironment("ROOM_CREATOR_KEY", previous.creator);
      restoreEnvironment("ROOM_SIGNING_SECRET", previous.signing);
      restoreEnvironment("UNRELATED_API_TOKEN", previous.unrelated);
      restoreEnvironment("GET_A_ROOM_HOME", previous.roomHome);
    }
    expect(JSON.parse(await readFile(capture, "utf8"))).toEqual({
      path: process.env.PATH,
      roomHome: fixture.directory,
    });
  });

  it("resumes the selected Codex thread with a safe room-check prompt", async () => {
    const fixture = await executable("");
    const capture = join(fixture.directory, "codex.json");
    await writeFile(fixture.path, `#!/usr/bin/env node
      import { writeFile } from "node:fs/promises";
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      await writeFile(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), prompt: Buffer.concat(chunks).toString("utf8") }));
    `, "utf8");
    await chmod(fixture.path, 0o700);

    await expect(codexWakeAdapter(fixture.path, "thread-123").wake(event)).resolves.toBe("accepted");
    const value = JSON.parse(await readFile(capture, "utf8")) as { argv: string[]; prompt: string };
    expect(value.argv).toEqual(["exec", "resume", "thread-123", "-"]);
    expect(value.prompt).toContain(`get-a-room check --session ${event.localSessionId}`);
    expect(value.prompt).toContain("human observer");
    expect(value.prompt).not.toContain("invite=");
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

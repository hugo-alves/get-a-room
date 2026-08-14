import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOM_ID = "abcdef0123456789abcdef0123456789";
const CAPABILITY = `${Buffer.from(JSON.stringify({ room_id: ROOM_ID, role: "guest" })).toString("base64url")}.guest-secret`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "get-a-room-listen-cli-"));
  temporaryDirectories.push(path);
  return path;
}

function send(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function mockServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const instance = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname.endsWith("/task")) {
      send(response, { task: "Work visibly through the shared room." });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/status")) {
      send(response, {
        room_id: ROOM_ID,
        status: "open",
        created_at: "2026-08-14T00:00:00.000Z",
        expires_at: "2030-01-01T00:00:00.000Z",
        message_count: 1,
        message_bytes: 12,
        message_bytes_limit: 1000,
        attachment_count: 0,
        attachment_bytes: 0,
        attachment_bytes_limit: 1000,
        last_number: 1,
        has_final: false,
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/messages")) {
      const after = Number(url.searchParams.get("after") ?? "0");
      send(response, {
        messages: after < 1
          ? [{
              number: 1,
              role: "creator",
              text: "private peer text that must stay in the room",
              created_at: "2026-08-14T00:00:01.000Z",
              attachments: [],
            }]
          : [],
      });
      return;
    }
    send(response, { error: "not_found" }, 404);
  });
  await new Promise<void>((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", resolve);
  });
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("server failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())),
  };
}

async function run(args: string[], home: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "cli/get-a-room.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, GET_A_ROOM_HOME: home, GET_A_ROOM_INVITATION: undefined },
    timeout: 10_000,
  });
}

describe("get-a-room listen", () => {
  it("wakes through an executable, proves cursor handling, and deduplicates after restart", async () => {
    const home = await temp();
    const fixture = await temp();
    const capture = join(fixture, "events.jsonl");
    const adapter = join(fixture, "adapter.mjs");
    await writeFile(adapter, `#!/usr/bin/env node
      import { appendFile, readFile, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await appendFile(${JSON.stringify(capture)}, JSON.stringify(event) + "\\n");
      const path = join(process.env.GET_A_ROOM_HOME, "sessions", event.localSessionId + ".json");
      const session = JSON.parse(await readFile(path, "utf8"));
      session.last_number = Math.max(session.last_number, event.throughCursor);
      session.last_checked_number = event.throughCursor;
      await writeFile(path, JSON.stringify(session, null, 2) + "\\n", { mode: 0o600 });
    `, "utf8");
    await chmod(adapter, 0o700);
    await mkdir(home, { recursive: true });
    const mock = await mockServer();

    try {
      const invitation = `${mock.url}/join#invite=${encodeURIComponent(CAPABILITY)}`;
      const joined = await run(["join", "--base-url", mock.url, "--invitation", invitation, "--json"], home);
      const sessionId = (JSON.parse(joined.stdout) as { session_id: string }).session_id;
      const sessionPath = join(home, "sessions", `${sessionId}.json`);
      const saved = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
      saved.last_number = 2;
      saved.last_checked_number = 0;
      await writeFile(sessionPath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });

      const first = await run([
        "listen", "--session", sessionId, "--wake-command", adapter, "--seconds", "0", "--once", "--json",
      ], home);
      expect(first.stderr).toBe("");
      expect(JSON.parse(first.stdout)).toEqual({ reason: "handled", throughCursor: 1 });

      const second = await run([
        "listen", "--session", sessionId, "--wake-command", adapter, "--seconds", "0", "--once", "--json",
      ], home);
      expect(JSON.parse(second.stdout)).toEqual({ reason: "idle" });

      const events = (await readFile(capture, "utf8")).trim().split("\n");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!)).toMatchObject({ afterCursor: 0, throughCursor: 1 });
      expect(events[0]).not.toContain(CAPABILITY);
      expect(events[0]).not.toContain("private peer text");
    } finally {
      await mock.close();
    }
  });
});

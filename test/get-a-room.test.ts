import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOM_ID = "abcdef0123456789abcdef0123456789";
const temporaryDirectories: string[] = [];

function invite(role: "creator" | "guest" | "observer"): string {
  return `${Buffer.from(JSON.stringify({ room_id: ROOM_ID, role })).toString("base64url")}.${role}-secret`;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "get-a-room-test-"));
  temporaryDirectories.push(path);
  return path;
}

function send(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function requestBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function server(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const instance = createServer(handler);
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

async function run(args: string[], home: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await execFileAsync(process.execPath, ["--import", "tsx", "cli/get-a-room.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GET_A_ROOM_HOME: home,
      GET_A_ROOM_INVITATION: undefined,
      ...env,
    },
    timeout: 10_000,
  });
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("get-a-room", () => {
  it("creates a private lead session and outputs only the guest invitation", async () => {
    const home = await temp();
    const task = join(home, "task.md");
    await writeFile(task, "Review the proposed change.", "utf8");
    const creator = invite("creator");
    const guest = invite("guest");
    const observer = invite("observer");
    let creationAuthorization: string | undefined;
    const mock = await server((request, response) => {
      creationAuthorization = request.headers.authorization;
      const origin = `http://${request.headers.host}`;
      const guestUrl = `${origin}/join#invite=${encodeURIComponent(guest)}`;
      const observerUrl = `${origin}/watch#invite=${encodeURIComponent(observer)}`;
      send(response, {
        room_id: ROOM_ID,
        expires_at: "2030-01-01T00:00:00.000Z",
        creator_capability: creator,
        guest_invitation_url: guestUrl,
        guest_invitation_message: `Join me with ${guestUrl}`,
        observer_url: observerUrl,
        observer_message: `Watch live at ${observerUrl}`,
      }, 201);
    });

    try {
      const output = await run([
        "create", "--base-url", mock.url, "--task", task, "--json",
      ], home);
      const value = JSON.parse(output) as {
        invitation: string;
        guest_invitation_message: string;
        observer_url: string;
        session_id: string;
      };
      expect(value.guest_invitation_message).toContain(`${mock.url}/join#invite=`);
      expect(value.guest_invitation_message).toContain(encodeURIComponent(guest));
      expect(value.invitation).toBe(value.guest_invitation_message);
      expect(value.observer_url).toContain(`${mock.url}/watch#invite=`);
      expect(output).not.toContain(creator);
      expect(output).not.toContain("creator-key");
      expect(creationAuthorization).toBeUndefined();

      const saved = JSON.parse(await readFile(join(home, "sessions", `${value.session_id}.json`), "utf8")) as {
        role: string;
        invite: string;
        observer_url: string;
      };
      expect(saved).toMatchObject({ role: "lead", invite: creator });
      expect(saved.observer_url).toContain(`${mock.url}/watch#invite=`);
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(join(home, "sessions", `${value.session_id}.json`))).mode & 0o777).toBe(0o600);
    } finally {
      await mock.close();
    }
  });

  it("shares initial and midway files and downloads them safely", async () => {
    const home = await temp();
    const task = join(home, "task.md");
    const initial = join(home, "brief.txt");
    const midway = join(home, "analysis.csv");
    const downloaded = join(home, "downloaded.csv");
    await writeFile(task, "Review the files.", "utf8");
    await writeFile(initial, "brief contents", "utf8");
    await writeFile(midway, "answer,42\n", "utf8");
    const creator = invite("creator");
    const guest = invite("guest");
    const observer = invite("observer");
    const attachments: Array<{
      id: string;
      filename: string;
      media_type: string;
      size: number;
      sha256: string;
      created_at: string;
      bytes: Buffer;
    }> = [];
    let messageNumber = 0;
    const mock = await server((request, response) => {
      void (async () => {
        const origin = `http://${request.headers.host}`;
        if (request.method === "POST" && request.url === "/v1/rooms") {
          const guestUrl = `${origin}/join#invite=${encodeURIComponent(guest)}`;
          return send(response, {
            room_id: ROOM_ID,
            expires_at: "2030-01-01T00:00:00.000Z",
            creator_capability: creator,
            guest_invitation_url: guestUrl,
            guest_invitation_message: `Join me with ${guestUrl}`,
            observer_url: `${origin}/watch#invite=${encodeURIComponent(observer)}`,
            observer_message: `Watch live at ${origin}/watch`,
          }, 201);
        }
        if (request.method === "POST" && request.url === `/v1/rooms/${ROOM_ID}/attachments`) {
          const bytes = await requestBytes(request);
          const id = `a_${String(attachments.length + 1).padStart(24, "0")}`;
          const filename = Buffer.from(String(request.headers["x-get-a-room-filename"]), "base64url").toString("utf8");
          const attachment = {
            id,
            filename,
            media_type: "application/octet-stream",
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            created_at: "2030-01-01T00:00:00.000Z",
            bytes,
          };
          attachments.push(attachment);
          return send(response, { attachment }, 201);
        }
        if (request.method === "POST" && request.url === `/v1/rooms/${ROOM_ID}/messages`) {
          const body = JSON.parse((await requestBytes(request)).toString("utf8")) as { text: string; attachment_ids: string[] };
          const attached = attachments.filter((attachment) => body.attachment_ids.includes(attachment.id));
          messageNumber += 1;
          return send(response, {
            message: {
              number: messageNumber,
              role: "creator",
              text: body.text,
              created_at: "2030-01-01T00:00:00.000Z",
              attachments: attached,
            },
          }, 201);
        }
        if (request.method === "GET" && request.url === `/v1/rooms/${ROOM_ID}/attachments`) {
          return send(response, { attachments });
        }
        const downloadMatch = new RegExp(`^/v1/rooms/${ROOM_ID}/attachments/(a_[0-9]+)$`).exec(request.url ?? "");
        if (request.method === "GET" && downloadMatch?.[1]) {
          const attachment = attachments.find((item) => item.id === downloadMatch[1]);
          if (!attachment) return send(response, { error: "not_found" }, 404);
          response.writeHead(200, {
            "content-type": attachment.media_type,
            "content-length": String(attachment.size),
            "x-content-sha256": attachment.sha256,
          });
          response.end(attachment.bytes);
          return;
        }
        send(response, { error: "not_found" }, 404);
      })().catch((error: unknown) => send(response, { error: String(error) }, 500));
    });

    try {
      const created = JSON.parse(await run([
        "create", "--base-url", mock.url, "--task", task, "--attach", initial, "--json",
      ], home)) as { session_id: string; attachment: { id: string } };
      expect(created.attachment.id).toBe("a_000000000000000000000001");

      const shared = JSON.parse(await run([
        "share", "--session", created.session_id, "--file", midway, "--text", "Updated totals", "--json",
      ], home)) as { attachment: { id: string } };
      expect(shared.attachment.id).toBe("a_000000000000000000000002");

      await run([
        "download", "--session", created.session_id, "--attachment", shared.attachment.id, "--out", downloaded, "--json",
      ], home);
      await expect(readFile(downloaded, "utf8")).resolves.toBe("answer,42\n");
      await expect(run([
        "download", "--session", created.session_id, "--attachment", shared.attachment.id, "--out", downloaded, "--json",
      ], home)).rejects.toThrow("Refusing to overwrite existing file");
    } finally {
      await mock.close();
    }
  });

  it("joins from a full forwarded invitation and remembers the guest session", async () => {
    const home = await temp();
    const guest = invite("guest");
    const mock = await server((request, response) => {
      if (request.url?.endsWith("/task")) return send(response, { task: "Check the numbers." });
      if (request.url?.endsWith("/status")) return send(response, { expires_at: "2030-01-01T00:00:00.000Z" });
      send(response, { error: "not_found" }, 404);
    });
    const invitation = `Get A Room invitation\n\nGive this to the agent:\n${mock.url}/join#invite=${encodeURIComponent(guest)}`;

    try {
      const output = await run(["join", "--base-url", mock.url, "--invitation", invitation, "--json"], home);
      const joined = JSON.parse(output) as { session_id: string };
      expect(joined).toMatchObject({ room_id: ROOM_ID, role: "guest", task: "Check the numbers." });
      const saved = JSON.parse(await readFile(join(home, "sessions", `${joined.session_id}.json`), "utf8")) as {
        role: string;
        invite: string;
      };
      expect(saved).toMatchObject({ role: "guest", invite: guest });
    } finally {
      await mock.close();
    }
  });

  it("rejects invitations from an unconfigured host before sending the capability", async () => {
    const home = await temp();
    const guest = invite("guest");
    const invitation = `https://attacker.invalid/join#invite=${encodeURIComponent(guest)}`;

    await expect(run(["join", "--invitation", invitation], home)).rejects.toThrow("invitation host is not trusted");
  });

  it("renders terminal control sequences from room content inert", async () => {
    const home = await temp();
    const guest = invite("guest");
    const task = "Review this\u001b]52;c;Y2xpcGJvYXJk\u0007 task";
    const mock = await server((request, response) => {
      if (request.url?.endsWith("/task")) return send(response, { task });
      if (request.url?.endsWith("/status")) return send(response, { expires_at: "2030-01-01T00:00:00.000Z" });
      send(response, { error: "not_found" }, 404);
    });
    const invitation = `${mock.url}/join#invite=${encodeURIComponent(guest)}`;

    try {
      const output = await run(["join", "--base-url", mock.url, "--invitation", invitation], home);
      expect(output).not.toContain("\u001b");
      expect(output).not.toContain("\u0007");
      expect(output).toContain("Review this�]52;c;Y2xpcGJvYXJk� task");
    } finally {
      await mock.close();
    }
  });

  it("keeps lead and guest sessions separate when agents share one checkout", async () => {
    const home = await temp();
    const task = join(home, "task.md");
    await writeFile(task, "Review the proposed change.", "utf8");
    const creator = invite("creator");
    const guest = invite("guest");
    const observer = invite("observer");
    const mock = await server((request, response) => {
      if (request.method === "POST" && request.url === "/v1/rooms") {
        const origin = `http://${request.headers.host}`;
        const guestUrl = `${origin}/join#invite=${encodeURIComponent(guest)}`;
        return send(response, {
          room_id: ROOM_ID,
          expires_at: "2030-01-01T00:00:00.000Z",
          creator_capability: creator,
          guest_invitation_url: guestUrl,
          guest_invitation_message: `Join using ${guestUrl}`,
          observer_url: `${origin}/watch#invite=${encodeURIComponent(observer)}`,
          observer_message: `Watch live at ${origin}/watch`,
        }, 201);
      }
      if (request.url?.endsWith("/task")) return send(response, { task: "Review the proposed change." });
      if (request.url?.endsWith("/status")) return send(response, { expires_at: "2030-01-01T00:00:00.000Z" });
      send(response, { error: "not_found" }, 404);
    });
    try {
      const created = JSON.parse(await run([
        "create", "--base-url", mock.url, "--task", task, "--json",
      ], home)) as { guest_invitation_message: string; session_id: string };
      const joinedOutput = JSON.parse(await run([
        "join", "--base-url", mock.url, "--invitation", created.guest_invitation_message, "--json",
      ], home)) as { session_id: string };

      expect(created.session_id).not.toBe(joinedOutput.session_id);
      const leadPath = join(home, "sessions", `${created.session_id}.json`);
      const guestPath = join(home, "sessions", `${joinedOutput.session_id}.json`);
      const lead = JSON.parse(await readFile(leadPath, "utf8")) as { role: string; creator_invite: string | null };
      const joined = JSON.parse(await readFile(guestPath, "utf8")) as { role: string; creator_invite: string | null };

      expect(lead).toMatchObject({ role: "lead", creator_invite: creator });
      expect(joined).toMatchObject({ role: "guest", creator_invite: null });
      await expect(run(["status", "--session", created.session_id, "--json"], home)).resolves.toContain('"role":"lead"');
      await expect(run(["status", "--session", joinedOutput.session_id, "--json"], home)).resolves.toContain('"role":"guest"');
    } finally {
      await mock.close();
    }
  });

  it("removes capabilities from the local session after closing", async () => {
    const home = await temp();
    const task = join(home, "task.md");
    await writeFile(task, "Review the proposed change.", "utf8");
    const creator = invite("creator");
    const guest = invite("guest");
    const observer = invite("observer");
    const mock = await server((request, response) => {
      if (request.method === "POST" && request.url === "/v1/rooms") {
        const origin = `http://${request.headers.host}`;
        const guestUrl = `${origin}/join#invite=${encodeURIComponent(guest)}`;
        return send(response, {
          room_id: ROOM_ID,
          expires_at: "2030-01-01T00:00:00.000Z",
          creator_capability: creator,
          guest_invitation_url: guestUrl,
          guest_invitation_message: `Join me with ${guestUrl}`,
          observer_url: `${origin}/watch#invite=${encodeURIComponent(observer)}`,
          observer_message: `Watch live at ${origin}/watch`,
        }, 201);
      }
      if (request.method === "DELETE" && request.url === `/v1/rooms/${ROOM_ID}`) {
        return send(response, { destroyed: true });
      }
      send(response, { error: "not_found" }, 404);
    });

    try {
      const created = JSON.parse(await run(["create", "--base-url", mock.url, "--task", task, "--json"], home)) as {
        session_id: string;
      };
      await run(["close", "--session", created.session_id, "--json"], home);

      const savedText = await readFile(join(home, "sessions", `${created.session_id}.json`), "utf8");
      const saved = JSON.parse(savedText) as {
        state: string;
        invite: string;
        creator_invite: string | null;
        guest_invitation: string | null;
        observer_url: string | null;
      };
      expect(saved).toMatchObject({
        state: "closed",
        invite: "",
        creator_invite: null,
        guest_invitation: null,
        observer_url: null,
      });
      expect(savedText).not.toContain(creator);
      expect(savedText).not.toContain(guest);
      expect(savedText).not.toContain(observer);
    } finally {
      await mock.close();
    }
  });
});

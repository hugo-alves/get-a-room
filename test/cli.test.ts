import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOM_ID = "0123456789abcdef0123456789abcdef";
const INVITE = `${Buffer.from(JSON.stringify({ room_id: ROOM_ID })).toString("base64url")}.test-signature`;
const temporaryDirectories: string[] = [];

interface CapturedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "roomctl-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function readRequest(request: IncomingMessage): Promise<CapturedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return {
    method: request.method ?? "GET",
    path: request.url ?? "/",
    headers: request.headers,
    body: text ? (JSON.parse(text) as unknown) : undefined,
  };
}

async function mockServer(
  handler: (request: CapturedRequest, response: ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    try {
      await handler(await readRequest(request), response);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "test server error");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", "cli/roomctl.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ROOM_INVITE: undefined, ROOM_CREATOR_KEY: undefined, ROOM_BASE_URL: undefined, ...env },
    timeout: 10_000,
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("roomctl", () => {
  it("creates a room using the canonical creator header and TTL in seconds", async () => {
    const directory = await temporaryDirectory();
    const taskPath = join(directory, "task.md");
    await writeFile(taskPath, "# Test task\n", "utf8");
    let captured: CapturedRequest | undefined;
    const server = await mockServer((request, response) => {
      captured = request;
      json(response, 201, {
        room_id: ROOM_ID,
        expires_at: "2030-01-01T00:00:00.000Z",
        invites: { creator: "one", proposer: "two", critic: "three" },
      });
    });

    try {
      const result = await runCli([
        "create",
        "--base-url",
        server.baseUrl,
        "--creator-key",
        "creator-secret",
        "--task",
        taskPath,
        "--ttl",
        "15m",
        "--json",
      ]);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ room_id: ROOM_ID });
      expect(captured).toMatchObject({
        method: "POST",
        path: "/v1/rooms",
        body: { task: "# Test task\n", ttl_seconds: 900 },
      });
      expect(captured?.headers["x-room-creator-key"]).toBe("creator-secret");
    } finally {
      await server.close();
    }
  });

  it("verifies the final SHA-256 before writing and confirming collection", async () => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, "result.md");
    const markdown = "# Final result\n\nSafe and verified.\n";
    const correctSha = createHash("sha256").update(markdown).digest("hex");
    let advertisedSha = "0".repeat(64);
    let collectionCount = 0;
    const server = await mockServer((request, response) => {
      if (request.method === "GET" && request.path === `/v1/rooms/${ROOM_ID}/final`) {
        json(response, 200, { markdown, sha256: advertisedSha });
        return;
      }
      if (request.method === "POST" && request.path === `/v1/rooms/${ROOM_ID}/collect`) {
        collectionCount += 1;
        json(response, 200, { collected: true, sha256: correctSha });
        return;
      }
      json(response, 404, { error: "not_found" });
    });

    try {
      await expect(
        runCli(["collect", "--base-url", server.baseUrl, "--invite", INVITE, "--out", outputPath, "--json"]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("SHA-256 mismatch") });
      expect(collectionCount).toBe(0);
      await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      advertisedSha = correctSha;
      const result = await runCli([
        "collect",
        "--base-url",
        server.baseUrl,
        "--invite",
        INVITE,
        "--out",
        outputPath,
        "--json",
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({ collected: true, sha256: correctSha });
      await expect(readFile(outputPath, "utf8")).resolves.toBe(markdown);
      expect(collectionCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("keeps invitation values out of server error diagnostics", async () => {
    const server = await mockServer((_request, response) => {
      json(response, 500, { message: `failure involving ${INVITE}` });
    });
    try {
      await expect(
        runCli(["status", "--base-url", server.baseUrl, "--invite", INVITE]),
      ).rejects.toSatisfy((error: unknown) => {
        const stderr = (error as { stderr?: string }).stderr ?? "";
        return stderr.includes("[REDACTED]") && !stderr.includes(INVITE);
      });
    } finally {
      await server.close();
    }
  });
});

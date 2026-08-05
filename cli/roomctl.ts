#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type FlagValue = string | boolean;
type Flags = Record<string, FlagValue>;

interface ParsedArgs {
  command: string | undefined;
  flags: Flags;
}

interface ApiResponse {
  response: Response;
  body: unknown;
}

class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

const DEFAULT_BASE_URL = "https://getaroom.run";

const HELP = `Usage: roomctl <command> [options]

Commands:
  create   --task <file> [--ttl 24h] [--json]
  status   [--invite <token>]
  task     [--invite <token>]
  read     [--invite <token>] [--after 0]
  wait     [--invite <token>] [--after 0] [--seconds 5]
  send     [--invite <token>] --text <text>
  final    [--invite <token>] --file <file>
  collect  [--invite <token>] --out <file>
  destroy  [--invite <token>]

Global options:
  --base-url <url>   Worker URL (or ROOM_BASE_URL)
  --invite <token>   Room invitation (or ROOM_INVITE)
  --json             Emit machine-readable JSON on stdout
  --help             Show this help

Creation is anonymous. Capability values are never included in errors, and all diagnostics go to stderr.`;

const VALUE_FLAGS = new Set([
  "base-url",
  "invite",
  "task",
  "ttl",
  "after",
  "seconds",
  "text",
  "file",
  "out",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Flags = {};
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) break;
    if (!argument.startsWith("--")) {
      if (command) throw new CliError(`Unexpected argument: ${argument}`);
      command = argument;
      continue;
    }

    const equalAt = argument.indexOf("=");
    const name = argument.slice(2, equalAt === -1 ? undefined : equalAt);
    if (!name) throw new CliError("Invalid empty option");
    if (name === "json" || name === "help") {
      if (equalAt !== -1) throw new CliError(`--${name} does not accept a value`);
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new CliError(`Unknown option: --${name}`);

    const value = equalAt === -1 ? argv[index + 1] : argument.slice(equalAt + 1);
    if (!value || (equalAt === -1 && value.startsWith("--"))) {
      throw new CliError(`Missing value for --${name}`);
    }
    if (equalAt === -1) index += 1;
    flags[name] = value;
  }
  return { command, flags };
}

function flag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function required(flags: Flags, name: string): string {
  const value = flag(flags, name);
  if (!value) throw new CliError(`Missing required option --${name}`);
  return value;
}

function nonNegativeInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new CliError(`--${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliError(`--${name} is too large`);
  return parsed;
}

function ttlSeconds(value: string): number {
  const match = /^(\d+)(s|m|h|d)?$/.exec(value);
  if (!match?.[1]) throw new CliError("--ttl must be a duration such as 15m, 24h, or 7d");
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds < 900 || seconds > 604800) {
    throw new CliError("--ttl must be between 15 minutes and 7 days");
  }
  return seconds;
}

function getBaseUrl(flags: Flags): string {
  const raw = flag(flags, "base-url") ?? process.env.ROOM_BASE_URL ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("Invalid --base-url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("--base-url must use http or https");
  }
  if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new CliError("--base-url must use HTTPS except for loopback development");
  }
  return url.toString().replace(/\/$/, "");
}

function getInvite(flags: Flags): string {
  const invite = flag(flags, "invite") ?? process.env.ROOM_INVITE;
  if (!invite) throw new CliError("Missing --invite (or ROOM_INVITE)");
  return invite;
}

function decodeBase64Url(value: string): string | undefined {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function roomIdFromInvite(invite: string): string {
  for (const segment of invite.split(".")) {
    const decoded = decodeBase64Url(segment);
    if (!decoded) continue;
    try {
      const payload = JSON.parse(decoded) as Record<string, unknown>;
      const roomId = payload.room_id ?? payload.roomId;
      if (typeof roomId === "string" && roomId.length > 0) return roomId;
    } catch {
      // Signature and header segments are not expected to be JSON payloads.
    }
  }
  throw new CliError("The invitation has an invalid format");
}

function roomPath(baseUrl: string, roomId: string, suffix: string): string {
  return `${baseUrl}/v1/rooms/${encodeURIComponent(roomId)}/${suffix}`;
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CliError(`Server returned invalid JSON (HTTP ${response.status})`);
    }
  }
  return text;
}

function errorDetail(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["error", "message", "detail"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return undefined;
}

async function api(url: string, init: RequestInit, secrets: string[]): Promise<ApiResponse> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network request failed";
    throw new CliError(redact(`Request failed: ${detail}`, secrets));
  }
  const body = await parseResponse(response);
  if (!response.ok) {
    const detail = errorDetail(body);
    const message = detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`;
    throw new CliError(redact(message, secrets));
  }
  return { response, body };
}

function redact(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  // Defense in depth for JWT-like or long opaque bearer values echoed by a server.
  return redacted.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
}

function bearer(invite: string): HeadersInit {
  return { authorization: `Bearer ${invite}`, accept: "application/json" };
}

function jsonRequest(invite: string, value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...bearer(invite), "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function pretty(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function output(value: unknown, json: boolean): void {
  if (json) printJson(value);
  else pretty(value);
}

async function createRoom(flags: Flags, json: boolean): Promise<void> {
  const baseUrl = getBaseUrl(flags);
  const task = await readFile(required(flags, "task"), "utf8");
  const ttl = ttlSeconds(flag(flags, "ttl") ?? "24h");
  const { body } = await api(
    `${baseUrl}/v1/rooms`,
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ task, ttl_seconds: ttl }),
    },
    [],
  );
  output(body, json);
}

async function inviteGet(flags: Flags, suffix: string, query?: URLSearchParams): Promise<unknown> {
  const baseUrl = getBaseUrl(flags);
  const invite = getInvite(flags);
  const roomId = roomIdFromInvite(invite);
  const url = roomPath(baseUrl, roomId, suffix) + (query ? `?${query.toString()}` : "");
  const { body } = await api(url, { headers: bearer(invite) }, [invite]);
  return body;
}

async function send(flags: Flags, json: boolean): Promise<void> {
  const baseUrl = getBaseUrl(flags);
  const invite = getInvite(flags);
  const roomId = roomIdFromInvite(invite);
  const { body } = await api(
    roomPath(baseUrl, roomId, "messages"),
    jsonRequest(invite, { text: required(flags, "text") }),
    [invite],
  );
  output(body, json);
}

async function submitFinal(flags: Flags, json: boolean): Promise<void> {
  const baseUrl = getBaseUrl(flags);
  const invite = getInvite(flags);
  const roomId = roomIdFromInvite(invite);
  const markdown = await readFile(required(flags, "file"), "utf8");
  const { body } = await api(
    roomPath(baseUrl, roomId, "final"),
    jsonRequest(invite, { markdown }),
    [invite],
  );
  output(body, json);
}

function downloadedFinal(response: Response, body: unknown): { markdown: string; sha256: string } {
  if (typeof body === "string") {
    const sha256 =
      response.headers.get("x-result-sha256") ??
      response.headers.get("x-sha256") ??
      response.headers.get("etag")?.replace(/^W\//, "").replaceAll('"', "");
    if (!sha256) throw new CliError("Final response did not include a SHA-256 digest");
    return { markdown: body, sha256 };
  }
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const markdown = record.markdown ?? record.content ?? record.result;
    const sha256 = record.sha256 ?? record.hash;
    if (typeof markdown === "string" && typeof sha256 === "string") return { markdown, sha256 };
  }
  throw new CliError("Final response has an invalid format");
}

async function collect(flags: Flags, json: boolean): Promise<void> {
  const baseUrl = getBaseUrl(flags);
  const invite = getInvite(flags);
  const roomId = roomIdFromInvite(invite);
  const destination = resolve(required(flags, "out"));
  const { response, body } = await api(
    roomPath(baseUrl, roomId, "final"),
    { headers: bearer(invite) },
    [invite],
  );
  const final = downloadedFinal(response, body);
  const expected = final.sha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new CliError("Final response included an invalid SHA-256 digest");

  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.roomctl-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  let moved = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(final.markdown, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const actual = createHash("sha256").update(final.markdown, "utf8").digest("hex");
    if (actual !== expected) {
      throw new CliError(`SHA-256 mismatch; expected ${expected}, received ${actual}`);
    }
    await rename(temporary, destination);
    moved = true;

    await api(
      roomPath(baseUrl, roomId, "collect"),
      jsonRequest(invite, { sha256: actual }),
      [invite],
    );
    output({ room_id: roomId, out: destination, sha256: actual, collected: true }, json);
  } finally {
    if (!moved) await rm(temporary, { force: true });
  }
}

async function destroy(flags: Flags, json: boolean): Promise<void> {
  const baseUrl = getBaseUrl(flags);
  const invite = getInvite(flags);
  const roomId = roomIdFromInvite(invite);
  const { body } = await api(
    `${baseUrl}/v1/rooms/${encodeURIComponent(roomId)}`,
    { method: "DELETE", headers: bearer(invite) },
    [invite],
  );
  output(body ?? { room_id: roomId, destroyed: true }, json);
}

async function main(argv: string[]): Promise<void> {
  const { command, flags } = parseArgs(argv);
  const json = flags.json === true;
  if (flags.help === true || !command) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  switch (command) {
    case "create":
      await createRoom(flags, json);
      return;
    case "status":
      output(await inviteGet(flags, "status"), json);
      return;
    case "task":
      output(await inviteGet(flags, "task"), json);
      return;
    case "read": {
      const after = nonNegativeInteger(flag(flags, "after"), "after", 0);
      output(await inviteGet(flags, "messages", new URLSearchParams({ after: String(after) })), json);
      return;
    }
    case "wait": {
      const after = nonNegativeInteger(flag(flags, "after"), "after", 0);
      const seconds = nonNegativeInteger(flag(flags, "seconds"), "seconds", 5);
      if (seconds > 5) throw new CliError("--seconds cannot exceed 5");
      output(
        await inviteGet(
          flags,
          "messages",
          new URLSearchParams({ after: String(after), wait: String(seconds) }),
        ),
        json,
      );
      return;
    }
    case "send":
      await send(flags, json);
      return;
    case "final":
      await submitFinal(flags, json);
      return;
    case "collect":
      await collect(flags, json);
      return;
    case "destroy":
      await destroy(flags, json);
      return;
    default:
      throw new CliError(`Unknown command: ${command}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  const secrets = [
    process.env.ROOM_INVITE ?? "",
    ...process.argv
      .map((argument, index, all) =>
        all[index - 1] === "--invite"
          ? argument
          : argument.startsWith("--invite=")
            ? argument.slice(argument.indexOf("=") + 1)
            : "",
      )
      .filter(Boolean),
  ];
  process.stderr.write(`roomctl: ${redact(message, secrets)}\n`);
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});

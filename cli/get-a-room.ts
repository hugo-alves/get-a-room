#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

type FlagValue = string | boolean;
type Flags = Record<string, FlagValue>;
type AgentRole = "lead" | "guest";

interface Session {
  version: 1;
  room_id: string;
  base_url: string;
  role: AgentRole;
  invite: string;
  creator_invite: string | null;
  guest_invitation: string | null;
  expires_at: string | null;
  last_number: number;
  state: "open" | "finished" | "collected" | "closed";
}

interface CreatedRoom {
  room_id: string;
  expires_at: string;
  invites: { creator: string; proposer: string; critic: string };
}

interface RoomMessage {
  number: number;
  role: "proposer" | "critic";
  text: string;
  created_at?: string;
}

class CommandError extends Error {}

const DEFAULT_BASE_URL = "https://get-a-room.pissa.workers.dev";
const VALUE_FLAGS = new Set([
  "base-url",
  "creator-key",
  "task",
  "summary",
  "ttl",
  "invitation",
  "room",
  "text",
  "seconds",
  "file",
  "out",
]);

const HELP = `Get A Room — private collaboration for agents on different machines

Usage:
  get-a-room create  --task <file> [--summary <safe text>] [--ttl 15m]
  get-a-room join    [--invitation <link>]
  get-a-room task
  get-a-room say     --text "..."
  get-a-room check   [--seconds 20]
  get-a-room status
  get-a-room finish  --file result.md
  get-a-room collect --out final.md
  get-a-room invite
  get-a-room close

The current room is remembered in .get-a-room/. Configuration can come from:
  GET_A_ROOM_URL or ROOM_BASE_URL
  GET_A_ROOM_CREATOR_KEY or ROOM_CREATOR_KEY
  GET_A_ROOM_INVITATION (for join)

Use --json for machine-readable output.`;

function parseArgs(argv: string[]): { command: string | undefined; flags: Flags } {
  const flags: Flags = {};
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) break;
    if (!argument.startsWith("--")) {
      if (command) throw new CommandError(`Unexpected argument: ${argument}`);
      command = argument;
      continue;
    }
    const equalAt = argument.indexOf("=");
    const name = argument.slice(2, equalAt === -1 ? undefined : equalAt);
    if (name === "json" || name === "help") {
      if (equalAt !== -1) throw new CommandError(`--${name} does not accept a value`);
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new CommandError(`Unknown option: --${name}`);
    const value = equalAt === -1 ? argv[index + 1] : argument.slice(equalAt + 1);
    if (!value || (equalAt === -1 && value.startsWith("--"))) {
      throw new CommandError(`Missing value for --${name}`);
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
  if (!value) throw new CommandError(`Missing --${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baseUrl(flags: Flags): string {
  const value = flag(flags, "base-url") ?? process.env.GET_A_ROOM_URL ?? process.env.ROOM_BASE_URL ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CommandError("The Get A Room address is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CommandError("The Get A Room address must use http or https");
  }
  return url.toString().replace(/\/$/u, "");
}

function ttlSeconds(value: string): number {
  const match = /^(\d+)(s|m|h)?$/u.exec(value);
  if (!match?.[1]) throw new CommandError("Use a duration such as 15m, 900s, or 1h");
  const amount = Number(match[1]);
  const multiplier = match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1;
  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 3600) {
    throw new CommandError("Rooms must last between 60 seconds and 1 hour");
  }
  return seconds;
}

function roomPath(url: string, roomId: string, suffix: string): string {
  return `${url}/v1/rooms/${encodeURIComponent(roomId)}/${suffix}`;
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

async function requestJson(url: string, init: RequestInit, secrets: string[]): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network request failed";
    throw new CommandError(redact(`Could not reach Get A Room: ${detail}`, secrets));
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
    throw new CommandError(redact(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`, secrets));
  }
  return { response, body };
}

function redact(value: string, secrets: string[]): string {
  let output = value;
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[REDACTED]");
  }
  return output.replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]");
}

function claimsFromInvite(invite: string): { room_id: string; role: string } {
  const payload = invite.split(".")[0];
  if (!payload) throw new CommandError("The invitation is invalid");
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isRecord(claims) || typeof claims.room_id !== "string" || typeof claims.role !== "string") {
      throw new Error("invalid claims");
    }
    if (!/^[0-9a-f]{32}$/u.test(claims.room_id)) throw new Error("invalid room id");
    return { room_id: claims.room_id, role: claims.role };
  } catch {
    throw new CommandError("The invitation is invalid");
  }
}

function invitationUrl(url: string, invite: string): string {
  return `${url}/join#invite=${encodeURIComponent(invite)}`;
}

function invitationMessage(summary: string, url: string, expiresAt: string): string {
  return `Get A Room invitation

A lead agent wants your help: ${summary}

Give this entire invitation to the other agent:
${url}

This private invitation expires at ${expiresAt}. Do not share it with anyone else.`;
}

function parseInvitation(value: string): { base_url: string; invite: string } {
  const match = /https?:\/\/[^\s<>"']+\/join#invite=[^\s<>"']+/u.exec(value);
  if (!match) throw new CommandError("No Get A Room invitation link was found");
  let url: URL;
  try {
    url = new URL(match[0].replace(/[),.;]+$/u, ""));
  } catch {
    throw new CommandError("The Get A Room invitation link is invalid");
  }
  const invite = new URLSearchParams(url.hash.slice(1)).get("invite");
  if (!invite) throw new CommandError("The Get A Room invitation is missing its private capability");
  const basePath = url.pathname.slice(0, -"/join".length).replace(/\/$/u, "");
  return { base_url: `${url.origin}${basePath}`, invite };
}

function sessionHome(): string {
  return resolve(process.env.GET_A_ROOM_HOME ?? join(process.cwd(), ".get-a-room"));
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function saveSession(session: Session): Promise<void> {
  const home = sessionHome();
  await writePrivate(join(home, `${session.room_id}.json`), `${JSON.stringify(session, null, 2)}\n`);
  await writePrivate(join(home, "active"), `${session.room_id}\n`);
}

function isSession(value: unknown): value is Session {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.room_id === "string" &&
    typeof value.base_url === "string" &&
    (value.role === "lead" || value.role === "guest") &&
    typeof value.invite === "string" &&
    (typeof value.creator_invite === "string" || value.creator_invite === null) &&
    (typeof value.guest_invitation === "string" || value.guest_invitation === null) &&
    (typeof value.expires_at === "string" || value.expires_at === null) &&
    Number.isInteger(value.last_number) &&
    ["open", "finished", "collected", "closed"].includes(String(value.state))
  );
}

async function loadSession(flags: Flags): Promise<Session> {
  const home = sessionHome();
  let roomId = flag(flags, "room");
  if (!roomId) {
    try {
      roomId = (await readFile(join(home, "active"), "utf8")).trim();
    } catch {
      throw new CommandError("There is no active room on this machine");
    }
  }
  if (!/^[0-9a-f]{32}$/u.test(roomId)) throw new CommandError("The saved room is invalid");
  try {
    const value: unknown = JSON.parse(await readFile(join(home, `${roomId}.json`), "utf8"));
    if (!isSession(value)) throw new Error("invalid session");
    return value;
  } catch {
    throw new CommandError("The saved room session could not be read");
  }
}

function createdRoom(value: unknown): CreatedRoom {
  if (!isRecord(value) || !isRecord(value.invites)) throw new CommandError("The room service returned an invalid response");
  const roomId = value.room_id;
  const expiresAt = value.expires_at;
  const creator = value.invites.creator;
  const proposer = value.invites.proposer;
  const critic = value.invites.critic;
  if (
    typeof roomId !== "string" ||
    typeof expiresAt !== "string" ||
    typeof creator !== "string" ||
    typeof proposer !== "string" ||
    typeof critic !== "string"
  ) {
    throw new CommandError("The room service returned an invalid response");
  }
  return { room_id: roomId, expires_at: expiresAt, invites: { creator, proposer, critic } };
}

function print(value: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function create(flags: Flags, json: boolean): Promise<void> {
  const url = baseUrl(flags);
  const creatorKey = flag(flags, "creator-key") ?? process.env.GET_A_ROOM_CREATOR_KEY ?? process.env.ROOM_CREATOR_KEY;
  if (!creatorKey) throw new CommandError("Get A Room is not configured to create rooms on this machine");
  const task = await readFile(required(flags, "task"), "utf8");
  const summary = (flag(flags, "summary") ?? "Review and improve a task with the lead agent")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  const ttl = ttlSeconds(flag(flags, "ttl") ?? "15m");
  const { body } = await requestJson(
    `${url}/v1/rooms`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-room-creator-key": creatorKey },
      body: JSON.stringify({ task, ttl_seconds: ttl }),
    },
    [creatorKey],
  );
  const room = createdRoom(body);
  const guestUrl = invitationUrl(url, room.invites.critic);
  const message = invitationMessage(summary || "Collaborate on a task", guestUrl, room.expires_at);
  await saveSession({
    version: 1,
    room_id: room.room_id,
    base_url: url,
    role: "lead",
    invite: room.invites.proposer,
    creator_invite: room.invites.creator,
    guest_invitation: message,
    expires_at: room.expires_at,
    last_number: 0,
    state: "open",
  });
  if (json) {
    print({ room_id: room.room_id, role: "lead", expires_at: room.expires_at, invitation: message }, true);
    return;
  }
  print(`Your room is ready. You joined as the lead agent.\n\nSend this entire invitation to the other agent:\n\n---\n${message}\n---`, false);
}

async function invitationInput(flags: Flags): Promise<string> {
  const direct = flag(flags, "invitation") ?? process.env.GET_A_ROOM_INVITATION;
  if (direct) return direct;
  if (process.stdin.isTTY) throw new CommandError("Paste the invitation through stdin or set GET_A_ROOM_INVITATION");
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!value) throw new CommandError("No invitation was provided");
  return value;
}

async function joinRoom(flags: Flags, json: boolean): Promise<void> {
  const parsed = parseInvitation(await invitationInput(flags));
  const claims = claimsFromInvite(parsed.invite);
  if (claims.role !== "critic") throw new CommandError("This is not a guest invitation");
  const [{ body: taskBody }, { body: statusBody }] = await Promise.all([
    requestJson(roomPath(parsed.base_url, claims.room_id, "task"), { headers: bearer(parsed.invite) }, [parsed.invite]),
    requestJson(roomPath(parsed.base_url, claims.room_id, "status"), { headers: bearer(parsed.invite) }, [parsed.invite]),
  ]);
  const task = isRecord(taskBody) && typeof taskBody.task === "string" ? taskBody.task : undefined;
  if (task === undefined) throw new CommandError("The room did not provide a readable task");
  const expiresAt = isRecord(statusBody) && typeof statusBody.expires_at === "string" ? statusBody.expires_at : null;
  await saveSession({
    version: 1,
    room_id: claims.room_id,
    base_url: parsed.base_url,
    role: "guest",
    invite: parsed.invite,
    creator_invite: null,
    guest_invitation: null,
    expires_at: expiresAt,
    last_number: 0,
    state: "open",
  });
  print(json ? { room_id: claims.room_id, role: "guest", expires_at: expiresAt, task } : `You joined the room as the guest agent.\n\nTask:\n${task}`, json);
}

async function task(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  const { body } = await requestJson(
    roomPath(session.base_url, session.room_id, "task"),
    { headers: bearer(session.invite) },
    [session.invite],
  );
  const value = isRecord(body) && typeof body.task === "string" ? body.task : undefined;
  if (value === undefined) throw new CommandError("The room did not provide a readable task");
  print(json ? { task: value } : value, json);
}

async function say(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  const text = required(flags, "text");
  const { body } = await requestJson(
    roomPath(session.base_url, session.room_id, "messages"),
    jsonRequest(session.invite, { text }),
    [session.invite],
  );
  const number = isRecord(body) && isRecord(body.message) && Number.isInteger(body.message.number)
    ? (body.message.number as number)
    : undefined;
  if (number === undefined) throw new CommandError("The room did not confirm the message");
  session.last_number = Math.max(session.last_number, number);
  await saveSession(session);
  print(json ? { sent: true, number } : `Message sent.`, json);
}

function seconds(flags: Flags): number {
  const raw = flag(flags, "seconds") ?? "20";
  if (!/^\d+$/u.test(raw)) throw new CommandError("--seconds must be a number from 0 to 20");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 20) throw new CommandError("--seconds must be a number from 0 to 20");
  return value;
}

function messages(value: unknown): RoomMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new CommandError("The room returned invalid messages");
  const result: RoomMessage[] = [];
  for (const item of value.messages) {
    if (
      !isRecord(item) ||
      !Number.isInteger(item.number) ||
      (item.role !== "proposer" && item.role !== "critic") ||
      typeof item.text !== "string"
    ) {
      throw new CommandError("The room returned an invalid message");
    }
    const createdAt = typeof item.created_at === "string" ? item.created_at : undefined;
    result.push({ number: item.number as number, role: item.role, text: item.text, ...(createdAt ? { created_at: createdAt } : {}) });
  }
  return result;
}

async function check(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  const query = new URLSearchParams({ after: String(session.last_number), wait: String(seconds(flags)) });
  const { body } = await requestJson(
    `${roomPath(session.base_url, session.room_id, "messages")}?${query.toString()}`,
    { headers: bearer(session.invite) },
    [session.invite],
  );
  const found = messages(body);
  if (found.length > 0) {
    session.last_number = Math.max(session.last_number, ...found.map((message) => message.number));
    await saveSession(session);
  }
  if (json) {
    print({ messages: found, last_number: session.last_number }, true);
    return;
  }
  if (found.length === 0) {
    print("No new message yet.", false);
    return;
  }
  print(found.map((message) => `${message.role === "proposer" ? "Lead" : "Guest"}: ${message.text}`).join("\n\n"), false);
}

async function status(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  const { body } = await requestJson(
    roomPath(session.base_url, session.room_id, "status"),
    { headers: bearer(session.invite) },
    [session.invite],
  );
  if (!isRecord(body)) throw new CommandError("The room returned an invalid status");
  const friendly = {
    room_id: session.room_id,
    role: session.role,
    state: body.status,
    messages: body.message_count,
    final_ready: body.has_final,
    expires_at: body.expires_at,
  };
  print(friendly, json);
}

async function finish(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  if (session.role !== "lead") throw new CommandError("Only the lead agent can finish the room");
  const markdown = await readFile(required(flags, "file"), "utf8");
  const { body } = await requestJson(
    roomPath(session.base_url, session.room_id, "final"),
    jsonRequest(session.invite, { markdown }),
    [session.invite],
  );
  const sha256 = isRecord(body) && typeof body.sha256 === "string" ? body.sha256 : undefined;
  if (!sha256) throw new CommandError("The room did not confirm the final result");
  session.state = "finished";
  await saveSession(session);
  print(json ? { finished: true, sha256 } : "Final result submitted. The room is ready to collect.", json);
}

async function collect(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  if (session.role !== "lead" || !session.creator_invite) throw new CommandError("Only the lead agent can collect the result");
  const destination = resolve(required(flags, "out"));
  const { body } = await requestJson(
    roomPath(session.base_url, session.room_id, "final"),
    { headers: bearer(session.creator_invite) },
    [session.creator_invite],
  );
  const markdown = isRecord(body) && typeof body.markdown === "string" ? body.markdown : undefined;
  const expected = isRecord(body) && typeof body.sha256 === "string" ? body.sha256.toLowerCase() : undefined;
  if (markdown === undefined || !expected || !/^[0-9a-f]{64}$/u.test(expected)) {
    throw new CommandError("The final result is invalid");
  }
  const actual = createHash("sha256").update(markdown, "utf8").digest("hex");
  if (actual !== expected) throw new CommandError("The final result failed its integrity check");

  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.get-a-room-${process.pid}-${randomBytes(5).toString("hex")}.tmp`;
  let moved = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(markdown, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    moved = true;
    await requestJson(
      roomPath(session.base_url, session.room_id, "collect"),
      jsonRequest(session.creator_invite, { sha256: actual }),
      [session.creator_invite],
    );
  } finally {
    if (!moved) await rm(temporary, { force: true });
  }
  session.state = "collected";
  await saveSession(session);
  print(json ? { collected: true, out: destination, sha256: actual } : `Result collected safely at ${destination}. The room is now closed.`, json);
}

async function showInvitation(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  if (!session.guest_invitation) throw new CommandError("This session does not have a guest invitation");
  print(json ? { invitation: session.guest_invitation } : session.guest_invitation, json);
}

async function close(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  if (session.role !== "lead" || !session.creator_invite) throw new CommandError("Only the lead agent can close the room");
  await requestJson(
    `${session.base_url}/v1/rooms/${encodeURIComponent(session.room_id)}`,
    { method: "DELETE", headers: bearer(session.creator_invite) },
    [session.creator_invite],
  );
  session.state = "closed";
  await saveSession(session);
  print(json ? { closed: true } : "The room is closed.", json);
}

async function main(argv: string[]): Promise<void> {
  const { command, flags } = parseArgs(argv);
  const json = flags.json === true;
  if (!command || flags.help === true) {
    print(HELP, false);
    return;
  }
  switch (command) {
    case "create": await create(flags, json); return;
    case "join": await joinRoom(flags, json); return;
    case "task": await task(flags, json); return;
    case "say": await say(flags, json); return;
    case "check": await check(flags, json); return;
    case "status": await status(flags, json); return;
    case "finish": await finish(flags, json); return;
    case "collect": await collect(flags, json); return;
    case "invite": await showInvitation(flags, json); return;
    case "close": await close(flags, json); return;
    default: throw new CommandError(`Unknown command: ${command}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  const secrets = [
    process.env.GET_A_ROOM_CREATOR_KEY ?? "",
    process.env.ROOM_CREATOR_KEY ?? "",
    process.env.GET_A_ROOM_INVITATION ?? "",
  ];
  process.stderr.write(`get-a-room: ${redact(message, secrets)}\n`);
  process.exitCode = 1;
});

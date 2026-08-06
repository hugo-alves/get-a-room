#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

type FlagValue = string | boolean;
type Flags = Record<string, FlagValue>;
type AgentRole = "lead" | "guest";

interface Session {
  version: 1;
  session_id?: string;
  room_id: string;
  base_url: string;
  role: AgentRole;
  invite: string;
  creator_invite: string | null;
  guest_invitation: string | null;
  observer_url?: string | null;
  expires_at: string | null;
  last_number: number;
  state: "open" | "finished" | "collected" | "closed";
}

interface CreatedRoom {
  room_id: string;
  expires_at: string;
  creator_capability: string;
  guest_invitation_url: string;
  guest_invitation_message: string;
  observer_url: string | null;
  observer_message: string | null;
}

interface RoomMessage {
  number: number;
  role: "creator" | "guest";
  text: string;
  created_at?: string;
  attachments: RoomAttachment[];
}

interface RoomAttachment {
  id: string;
  filename: string;
  media_type: string;
  size: number;
  sha256: string;
  created_at?: string;
}

class CommandError extends Error {}

const DEFAULT_BASE_URL = "https://getaroom.run";
const VALUE_FLAGS = new Set([
  "base-url",
  "attach",
  "attachment",
  "task",
  "ttl",
  "invitation",
  "session",
  "room",
  "text",
  "seconds",
  "file",
  "out",
]);

const HELP = `Get A Room — temporary collaboration for agents on different machines

Usage:
  get-a-room create  --task <file> [--ttl 24h]
  get-a-room join    [--invitation <link>]
  get-a-room task
  get-a-room say     --text "..."
  get-a-room share   --file <path> [--text "..."]
  get-a-room download --attachment <id> --out <path>
  get-a-room check   [--seconds 5]
  get-a-room status
  get-a-room finish  --file result.md
  get-a-room collect --out final.md
  get-a-room invite
  get-a-room close

The current room is remembered in .get-a-room/. Configuration can come from:
  GET_A_ROOM_URL or ROOM_BASE_URL
  GET_A_ROOM_INVITATION (for join)
  GET_A_ROOM_SESSION (for selecting a local session)

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
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new CommandError("The Get A Room address must use HTTPS except for loopback development");
  }
  return url.toString().replace(/\/$/u, "");
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function ttlSeconds(value: string): number {
  const match = /^(\d+)(s|m|h|d)?$/u.exec(value);
  if (!match?.[1]) throw new CommandError("Use a duration such as 15m, 900s, or 1d");
  const amount = Number(match[1]);
  const multiplier = match[2] === "d" ? 86400 : match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1;
  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds < 900 || seconds > 604800) {
    throw new CommandError("Rooms must last between 15 minutes and 7 days");
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

function safeTerminalText(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const unsafe =
      codePoint <= 8 ||
      (codePoint >= 11 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    output += unsafe ? "�" : character;
  }
  return output;
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

function parseInvitation(value: string, flags: Flags): { base_url: string; invite: string } {
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
  const invitationBaseUrl = `${url.origin}${basePath}`;
  const trustedBaseUrls = new Set([DEFAULT_BASE_URL, baseUrl(flags)]);
  if (!trustedBaseUrls.has(invitationBaseUrl)) {
    throw new CommandError("The invitation host is not trusted; configure its exact address with --base-url or GET_A_ROOM_URL");
  }
  return { base_url: invitationBaseUrl, invite };
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

function sessionIdIsValid(value: string): boolean {
  return /^s_[0-9a-f]{24}$/u.test(value);
}

async function saveSession(session: Session): Promise<string> {
  const home = sessionHome();
  const sessionId = session.session_id ?? `s_${randomBytes(12).toString("hex")}`;
  session.session_id = sessionId;
  await writePrivate(join(home, "sessions", `${sessionId}.json`), `${JSON.stringify(session, null, 2)}\n`);
  await writePrivate(join(home, "active"), `${sessionId}\n`);
  return sessionId;
}

async function saveSessionTombstone(session: Session, state: "collected" | "closed"): Promise<void> {
  session.state = state;
  session.invite = "";
  session.creator_invite = null;
  session.guest_invitation = null;
  session.observer_url = null;
  await saveSession(session);
}

function isSession(value: unknown): value is Session {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    (value.session_id === undefined || (typeof value.session_id === "string" && sessionIdIsValid(value.session_id))) &&
    typeof value.room_id === "string" &&
    typeof value.base_url === "string" &&
    (value.role === "lead" || value.role === "guest") &&
    typeof value.invite === "string" &&
    (typeof value.creator_invite === "string" || value.creator_invite === null) &&
    (typeof value.guest_invitation === "string" || value.guest_invitation === null) &&
    (typeof value.observer_url === "string" || value.observer_url === null || value.observer_url === undefined) &&
    (typeof value.expires_at === "string" || value.expires_at === null) &&
    Number.isInteger(value.last_number) &&
    ["open", "finished", "collected", "closed"].includes(String(value.state))
  );
}

async function loadSession(flags: Flags): Promise<Session> {
  const home = sessionHome();
  const selectedSession = flag(flags, "session") ?? process.env.GET_A_ROOM_SESSION;
  if (selectedSession !== undefined && !sessionIdIsValid(selectedSession)) {
    throw new CommandError("The local session ID is invalid");
  }
  let reference = selectedSession ?? flag(flags, "room");
  if (!reference) {
    try {
      reference = (await readFile(join(home, "active"), "utf8")).trim();
    } catch {
      throw new CommandError("There is no active room on this machine");
    }
  }
  const path = sessionIdIsValid(reference)
    ? join(home, "sessions", `${reference}.json`)
    : /^[0-9a-f]{32}$/u.test(reference)
      ? join(home, `${reference}.json`)
      : null;
  if (!path) throw new CommandError("The saved room or local session is invalid");
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isSession(value)) throw new Error("invalid session");
    return value;
  } catch {
    throw new CommandError("The saved room session could not be read");
  }
}

function createdRoom(value: unknown): CreatedRoom {
  if (!isRecord(value)) throw new CommandError("The room service returned an invalid response");
  const roomId = value.room_id;
  const expiresAt = value.expires_at;
  const creator = value.creator_capability;
  const guestInvitationUrl = value.guest_invitation_url;
  const guestInvitationMessage = value.guest_invitation_message;
  const observerUrl = value.observer_url;
  const observerMessage = value.observer_message;
  if (
    typeof roomId !== "string" ||
    typeof expiresAt !== "string" ||
    typeof creator !== "string" ||
    typeof guestInvitationUrl !== "string" ||
    typeof guestInvitationMessage !== "string" ||
    (typeof observerUrl !== "string" && observerUrl !== undefined) ||
    (typeof observerMessage !== "string" && observerMessage !== undefined)
  ) {
    throw new CommandError("The room service returned an invalid response");
  }
  return {
    room_id: roomId,
    expires_at: expiresAt,
    creator_capability: creator,
    guest_invitation_url: guestInvitationUrl,
    guest_invitation_message: guestInvitationMessage,
    observer_url: observerUrl ?? null,
    observer_message: observerMessage ?? null,
  };
}

function print(value: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function create(flags: Flags, json: boolean): Promise<void> {
  const url = baseUrl(flags);
  const task = await readFile(required(flags, "task"), "utf8");
  const ttl = ttlSeconds(flag(flags, "ttl") ?? "24h");
  const { body } = await requestJson(
    `${url}/v1/rooms`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ task, ttl_seconds: ttl }),
    },
    [],
  );
  const room = createdRoom(body);
  const session: Session = {
    version: 1,
    room_id: room.room_id,
    base_url: url,
    role: "lead",
    invite: room.creator_capability,
    creator_invite: room.creator_capability,
    guest_invitation: room.guest_invitation_message,
    observer_url: room.observer_url,
    expires_at: room.expires_at,
    last_number: 0,
    state: "open",
  };
  const sessionId = await saveSession(session);
  const initialFile = flag(flags, "attach");
  let initialAttachment: RoomAttachment | undefined;
  if (initialFile) {
    try {
      initialAttachment = await uploadAndAttach(session, initialFile, `Initial context: ${basename(initialFile)}`);
    } catch (error) {
      try {
        await requestJson(
          `${url}/v1/rooms/${encodeURIComponent(room.room_id)}`,
          { method: "DELETE", headers: bearer(room.creator_capability) },
          [room.creator_capability],
        );
        await saveSessionTombstone(session, "closed");
      } catch {
        // Preserve the original error. An unclosed room still expires automatically.
      }
      throw error;
    }
  }
  if (json) {
    print({
      room_id: room.room_id,
      session_id: sessionId,
      role: "lead",
      expires_at: room.expires_at,
      invitation: room.guest_invitation_message,
      guest_invitation_url: room.guest_invitation_url,
      guest_invitation_message: room.guest_invitation_message,
      observer_url: room.observer_url,
      observer_message: room.observer_message,
      ...(initialAttachment ? { attachment: initialAttachment } : {}),
    }, true);
    return;
  }
  const observerNote = room.observer_url
    ? `\n\nHumans can watch the room live (read-only) at this private link:\n${room.observer_url}`
    : "";
  print(
    `Your room is ready. You joined as the lead agent.\nLocal session ID (keep internal): ${sessionId}\n\nSend this entire invitation to the other agent:\n\n---\n${room.guest_invitation_message}\n---\n\nYou can also use this invitation URL:\n${room.guest_invitation_url}${observerNote}`,
    false,
  );
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
  const parsed = parseInvitation(await invitationInput(flags), flags);
  const claims = claimsFromInvite(parsed.invite);
  if (claims.role !== "guest" && claims.role !== "creator") {
    throw new CommandError("This is not a guest or lead invitation");
  }
  const role: AgentRole = claims.role === "creator" ? "lead" : "guest";
  const [{ body: taskBody }, { body: statusBody }] = await Promise.all([
    requestJson(roomPath(parsed.base_url, claims.room_id, "task"), { headers: bearer(parsed.invite) }, [parsed.invite]),
    requestJson(roomPath(parsed.base_url, claims.room_id, "status"), { headers: bearer(parsed.invite) }, [parsed.invite]),
  ]);
  const task = isRecord(taskBody) && typeof taskBody.task === "string" ? taskBody.task : undefined;
  if (task === undefined) throw new CommandError("The room did not provide a readable task");
  const expiresAt = isRecord(statusBody) && typeof statusBody.expires_at === "string" ? statusBody.expires_at : null;
  const sessionId = await saveSession({
    version: 1,
    room_id: claims.room_id,
    base_url: parsed.base_url,
    role,
    invite: parsed.invite,
    creator_invite: role === "lead" ? parsed.invite : null,
    guest_invitation: null,
    expires_at: expiresAt,
    last_number: 0,
    state: "open",
  });
  const leadNote = role === "lead"
    ? "You are the lead: run the room, integrate the guest's work, and finish/collect the final result."
    : "";
  print(
    json
      ? { room_id: claims.room_id, session_id: sessionId, role, expires_at: expiresAt, task }
      : `You joined the room as the ${role} agent.\nLocal session ID (keep internal): ${sessionId}\n${leadNote ? `${leadNote}\n` : ""}\nTask:\n${safeTerminalText(task)}`,
    json,
  );
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
  print(json ? { task: value } : safeTerminalText(value), json);
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

async function uploadAndAttach(session: Session, path: string, text: string): Promise<RoomAttachment> {
  const data = await readFile(path);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const filename = basename(path);
  const requestBody = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const { body: uploadBody } = await requestJson(
    roomPath(session.base_url, session.room_id, "attachments"),
    {
      method: "POST",
      headers: {
        ...bearer(session.invite),
        "content-length": String(data.byteLength),
        "content-type": "application/octet-stream",
        "x-get-a-room-filename": Buffer.from(filename, "utf8").toString("base64url"),
        "x-get-a-room-sha256": sha256,
        "x-get-a-room-size": String(data.byteLength),
      },
      body: requestBody,
    },
    [session.invite],
  );
  const attachment = parseAttachment(isRecord(uploadBody) ? uploadBody.attachment : undefined);
  const { body: messageBody } = await requestJson(
    roomPath(session.base_url, session.room_id, "messages"),
    jsonRequest(session.invite, { text, attachment_ids: [attachment.id] }),
    [session.invite],
  );
  const number = isRecord(messageBody) && isRecord(messageBody.message) && Number.isInteger(messageBody.message.number)
    ? messageBody.message.number as number
    : undefined;
  if (number === undefined) throw new CommandError("The room did not attach the file to a message");
  session.last_number = Math.max(session.last_number, number);
  await saveSession(session);
  return attachment;
}

async function share(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  const path = required(flags, "file");
  const attachment = await uploadAndAttach(session, path, flag(flags, "text") ?? `Shared file: ${basename(path)}`);
  print(json ? { shared: true, attachment } : `Shared ${attachment.filename} (${attachment.id}).`, json);
}

function seconds(flags: Flags): number {
  const raw = flag(flags, "seconds") ?? "5";
  if (!/^\d+$/u.test(raw)) throw new CommandError("--seconds must be a number from 0 to 5");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 5) throw new CommandError("--seconds must be a number from 0 to 5");
  return value;
}

function messages(value: unknown): RoomMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new CommandError("The room returned invalid messages");
  const result: RoomMessage[] = [];
  for (const item of value.messages) {
    if (
      !isRecord(item) ||
      !Number.isInteger(item.number) ||
      (item.role !== "creator" && item.role !== "guest") ||
      typeof item.text !== "string"
    ) {
      throw new CommandError("The room returned an invalid message");
    }
    const createdAt = typeof item.created_at === "string" ? item.created_at : undefined;
    if (item.attachments !== undefined && !Array.isArray(item.attachments)) {
      throw new CommandError("The room returned invalid attachments");
    }
    const attachments = (item.attachments ?? []).map(parseAttachment);
    result.push({
      number: item.number as number,
      role: item.role,
      text: item.text,
      attachments,
      ...(createdAt ? { created_at: createdAt } : {}),
    });
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
  print(found.map((message) => {
    const files = message.attachments
      .map((attachment) => `\n  File: ${safeTerminalText(attachment.filename)} (${attachment.id}, ${attachment.size} bytes)`)
      .join("");
    return `${message.role === "creator" ? "Lead" : "Guest"}: ${safeTerminalText(message.text)}${files}`;
  }).join("\n\n"), false);
}

function parseAttachment(value: unknown): RoomAttachment {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^a_[0-9a-f]{24}$/u.test(value.id) ||
    typeof value.filename !== "string" ||
    typeof value.media_type !== "string" ||
    !Number.isInteger(value.size) ||
    typeof value.sha256 !== "string"
  ) {
    throw new CommandError("The room returned an invalid attachment");
  }
  return {
    id: value.id,
    filename: value.filename,
    media_type: value.media_type,
    size: value.size as number,
    sha256: value.sha256,
    ...(typeof value.created_at === "string" ? { created_at: value.created_at } : {}),
  };
}

async function listAttachments(session: Session): Promise<RoomAttachment[]> {
  const { body } = await requestJson(
    roomPath(session.base_url, session.room_id, "attachments"),
    { headers: bearer(session.invite) },
    [session.invite],
  );
  if (!isRecord(body) || !Array.isArray(body.attachments)) throw new CommandError("The room returned invalid attachments");
  return body.attachments.map(parseAttachment);
}

async function downloadTo(
  session: Session,
  attachment: RoomAttachment,
  destination: string,
  reuseVerifiedExisting = false,
): Promise<void> {
  if (reuseVerifiedExisting) {
    try {
      const existing = await readFile(destination);
      const existingSha256 = createHash("sha256").update(existing).digest("hex");
      if (existing.byteLength === attachment.size && existingSha256 === attachment.sha256) return;
      throw new CommandError(`Refusing to overwrite existing file: ${destination}`);
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) throw error;
    }
  }
  let response: Response;
  try {
    response = await fetch(roomPath(session.base_url, session.room_id, `attachments/${attachment.id}`), {
      headers: bearer(session.invite),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network request failed";
    throw new CommandError(redact(`Could not download attachment: ${detail}`, [session.invite]));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CommandError(`Attachment download failed (HTTP ${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== attachment.size) throw new CommandError("Attachment download size did not match");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== attachment.sha256) throw new CommandError("Attachment download failed its integrity check");
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.get-a-room-${process.pid}-${randomBytes(5).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
    await rm(temporary);
  } catch (error) {
    await rm(temporary, { force: true });
    if (isRecord(error) && error.code === "EEXIST") {
      throw new CommandError(`Refusing to overwrite existing file: ${destination}`);
    }
    throw error;
  }
}

async function download(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  const id = required(flags, "attachment");
  const attachment = (await listAttachments(session)).find((item) => item.id === id);
  if (!attachment) throw new CommandError("The attachment was not found in this room");
  const destination = resolve(required(flags, "out"));
  await downloadTo(session, attachment, destination);
  print(json ? { downloaded: true, attachment, out: destination } : `Downloaded ${attachment.filename} to ${destination}.`, json);
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
    files: body.attachment_count ?? 0,
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

  const attachments = await listAttachments(session);
  const attachmentsDirectory = `${destination}.files`;
  for (const attachment of attachments) {
    await downloadTo(session, attachment, join(attachmentsDirectory, `${attachment.id}-${attachment.filename}`), true);
  }

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
  await saveSessionTombstone(session, "collected");
  print(
    json
      ? {
          collected: true,
          out: destination,
          sha256: actual,
          attachment_count: attachments.length,
          ...(attachments.length > 0 ? { attachments_dir: attachmentsDirectory } : {}),
        }
      : `Result collected safely at ${destination}.${attachments.length > 0 ? ` ${attachments.length} attachment(s) saved in ${attachmentsDirectory}.` : ""} The room is now closed.`,
    json,
  );
}

async function showInvitation(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  if (!session.guest_invitation) throw new CommandError("This session does not have a guest invitation");
  if (json) {
    print({ invitation: session.guest_invitation, observer_url: session.observer_url ?? null }, true);
    return;
  }
  const observerNote = session.observer_url
    ? `\n\nHumans can watch the room live (read-only) at this private link:\n${session.observer_url}`
    : "";
  print(`${session.guest_invitation}${observerNote}`, false);
}

async function close(flags: Flags, json: boolean): Promise<void> {
  const session = await loadSession(flags);
  if (session.role !== "lead" || !session.creator_invite) throw new CommandError("Only the lead agent can close the room");
  await requestJson(
    `${session.base_url}/v1/rooms/${encodeURIComponent(session.room_id)}`,
    { method: "DELETE", headers: bearer(session.creator_invite) },
    [session.creator_invite],
  );
  await saveSessionTombstone(session, "closed");
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
    case "share": await share(flags, json); return;
    case "download": await download(flags, json); return;
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
    process.env.GET_A_ROOM_INVITATION ?? "",
  ];
  process.stderr.write(`get-a-room: ${redact(message, secrets)}\n`);
  process.exitCode = 1;
});

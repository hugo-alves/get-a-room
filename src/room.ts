import {
  HttpError,
  MAX_CONCURRENT_LONG_POLLS,
  MAX_FINAL_BYTES,
  MAX_LONG_POLL_SECONDS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_RESPONSE_BYTES,
  MAX_MESSAGES_PER_RESPONSE,
  MAX_MESSAGES_PER_ROOM,
  MAX_TOTAL_MESSAGE_BYTES,
  MAX_TASK_BYTES,
  errorResponse,
  isParticipantRole,
  isReaderRole,
  json,
  readJson,
  requiredString,
  type InviteRole,
  type ParticipantRole,
  type RoomMessage,
  type RoomStatus,
} from "./shared";

interface MetaRow extends Record<string, SqlStorageValue> {
  room_id: string;
  state: RoomStatus;
  created_at: number;
  expires_at: number;
  task: string;
  final_markdown: string | null;
  final_sha256: string | null;
}

interface CountRow extends Record<string, SqlStorageValue> { count: number }
interface MessageRow extends Record<string, SqlStorageValue> {
  number: number;
  role: ParticipantRole;
  text: string;
  created_at: number;
}

export class Room implements DurableObject {
  private readonly sql: SqlStorage;
  private activeLongPolls = 0;

  constructor(private readonly state: DurableObjectState) {
    this.sql = state.storage.sql;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      return errorResponse(error);
    }
  }

  async alarm(): Promise<void> {
    const meta = this.getMeta();
    if (meta) await this.state.storage.deleteAll();
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/_initialize") return this.initialize(request);

    const meta = this.requireMeta();
    if (meta.expires_at <= Date.now()) {
      await this.state.storage.deleteAll();
      throw new HttpError(410, "room_gone", "Room no longer exists");
    }

    const role = request.headers.get("x-room-role");
    if (request.method === "GET" && url.pathname === "/status") return this.status(meta);
    if (request.method === "GET" && url.pathname === "/task") return this.task(meta, role);
    if (request.method === "GET" && url.pathname === "/messages") return this.messages(url, role);
    if (request.method === "POST" && url.pathname === "/messages") return this.addMessage(request, meta, role);
    if (request.method === "POST" && url.pathname === "/final") return this.submitFinal(request, meta, role);
    if (request.method === "GET" && url.pathname === "/final") return this.getFinal(meta, role);
    if (request.method === "POST" && url.pathname === "/collect") return this.collect(request, meta, role);
    if (request.method === "DELETE" && url.pathname === "/") return this.destroy(role);
    throw new HttpError(404, "not_found", "Route not found");
  }

  private async initialize(request: Request): Promise<Response> {
    if (this.getMeta()) throw new HttpError(409, "room_exists", "Room already exists");
    const body = await readJson(request, MAX_TASK_BYTES + 4096);
    assertFields(body, ["room_id", "task", "created_at", "expires_at"]);
    const roomId = requiredString(body.room_id, "room_id", 64);
    const task = requiredString(body.task, "task", MAX_TASK_BYTES, { allowEmpty: true });
    const createdAt = body.created_at;
    const expiresAt = body.expires_at;
    if (!Number.isInteger(createdAt) || !Number.isInteger(expiresAt) || (expiresAt as number) <= (createdAt as number)) {
      throw new HttpError(400, "invalid_request", "Invalid room timestamps");
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      room_id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      task TEXT NOT NULL, final_markdown TEXT, final_sha256 TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      number INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    this.sql.exec(
      "INSERT INTO meta (room_id, state, created_at, expires_at, task) VALUES (?, 'open', ?, ?, ?)",
      roomId,
      createdAt as number,
      expiresAt as number,
      task,
    );
    await this.state.storage.setAlarm(expiresAt as number);
    return json({ ok: true }, 201);
  }

  private status(meta: MetaRow): Response {
    const count = this.messageCount();
    const messageBytes = this.messageBytes();
    return json({
      room_id: meta.room_id,
      status: meta.state,
      created_at: new Date(meta.created_at).toISOString(),
      expires_at: new Date(meta.expires_at).toISOString(),
      message_count: count,
      message_bytes: messageBytes,
      message_bytes_limit: MAX_TOTAL_MESSAGE_BYTES,
      last_number: count,
      has_final: meta.final_sha256 !== null,
    });
  }

  private task(meta: MetaRow, role: string | null): Response {
    this.requireReader(role);
    return json({ task: meta.task });
  }

  private async messages(url: URL, role: string | null): Promise<Response> {
    this.requireReader(role);
    const after = parseBoundedInteger(url.searchParams.get("after"), "after", 0, Number.MAX_SAFE_INTEGER, 0);
    const wait = parseBoundedInteger(url.searchParams.get("wait"), "wait", 0, MAX_LONG_POLL_SECONDS, 0);
    const deadline = Date.now() + wait * 1000;
    let messages = this.messagesAfter(after);
    if (messages.length > 0 || wait === 0) return json({ messages });
    if (this.activeLongPolls >= MAX_CONCURRENT_LONG_POLLS) {
      throw new HttpError(429, "too_many_waiters", "Too many active room checks", { "retry-after": "1" });
    }
    this.activeLongPolls += 1;
    try {
      while (messages.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
        const meta = this.requireMeta();
        if (meta.expires_at <= Date.now()) {
          await this.state.storage.deleteAll();
          throw new HttpError(410, "room_gone", "Room no longer exists");
        }
        messages = this.messagesAfter(after);
      }
      return json({ messages });
    } finally {
      this.activeLongPolls -= 1;
    }
  }

  private async addMessage(request: Request, meta: MetaRow, roleValue: string | null): Promise<Response> {
    const role = this.requireParticipant(roleValue);
    if (meta.state !== "open") throw new HttpError(409, "room_finalized", "Room is finalized");
    if (this.messageCount() >= MAX_MESSAGES_PER_ROOM) {
      throw new HttpError(413, "room_message_count_exceeded", "Room message count limit exceeded");
    }
    const body = await readJson(request, MAX_MESSAGE_BYTES + 4096);
    assertFields(body, ["text"]);
    const text = requiredString(body.text, "text", MAX_MESSAGE_BYTES);
    const textBytes = new TextEncoder().encode(text).byteLength;
    this.requireCurrentOpenRoom();
    if (this.messageCount() >= MAX_MESSAGES_PER_ROOM) {
      throw new HttpError(413, "room_message_count_exceeded", "Room message count limit exceeded");
    }
    const currentBytes = this.messageBytes();
    if (currentBytes + textBytes > MAX_TOTAL_MESSAGE_BYTES) {
      throw new HttpError(413, "room_message_budget_exceeded", "Cumulative room message budget exceeded");
    }
    const createdAt = Date.now();
    this.sql.exec("INSERT INTO messages (role, text, created_at) VALUES (?, ?, ?)", role, text, createdAt);
    const row = [...this.sql.exec<MessageRow>("SELECT number, role, text, created_at FROM messages ORDER BY number DESC LIMIT 1")][0];
    if (!row) throw new Error("Inserted message was not found");
    return json({ message: mapMessage(row) }, 201);
  }

  private async submitFinal(request: Request, meta: MetaRow, role: string | null): Promise<Response> {
    this.requireRole(role, "creator");
    if (meta.state !== "open") throw new HttpError(409, "room_finalized", "Room is already finalized");
    const body = await readJson(request, MAX_FINAL_BYTES + 4096);
    assertFields(body, ["markdown"]);
    const markdown = requiredString(body.markdown, "markdown", MAX_FINAL_BYTES);
    const sha256 = await digest(markdown);
    this.requireCurrentOpenRoom();
    this.sql.exec("UPDATE meta SET state = 'finalized', final_markdown = ?, final_sha256 = ?", markdown, sha256);
    return json({ sha256 }, 201);
  }

  private getFinal(meta: MetaRow, role: string | null): Response {
    if (role !== "creator" && role !== "observer") throw new HttpError(403, "forbidden", "creator or observer invite required");
    if (meta.state !== "finalized" || meta.final_markdown === null || meta.final_sha256 === null) {
      throw new HttpError(409, "final_not_ready", "Final result is not ready");
    }
    return json({ markdown: meta.final_markdown, sha256: meta.final_sha256 });
  }

  private async collect(request: Request, meta: MetaRow, role: string | null): Promise<Response> {
    this.requireRole(role, "creator");
    if (meta.state !== "finalized" || meta.final_sha256 === null) {
      throw new HttpError(409, "final_not_ready", "Final result is not ready");
    }
    const body = await readJson(request, 4096);
    assertFields(body, ["sha256"]);
    const sha256 = requiredString(body.sha256, "sha256", 64);
    const current = this.requireMeta();
    if (current.expires_at <= Date.now()) {
      await this.state.storage.deleteAll();
      throw new HttpError(410, "room_gone", "Room no longer exists");
    }
    if (current.state !== "finalized" || current.final_sha256 === null) {
      throw new HttpError(409, "final_not_ready", "Final result is not ready");
    }
    if (!/^[0-9a-f]{64}$/u.test(sha256) || sha256 !== current.final_sha256) {
      throw new HttpError(409, "sha256_mismatch", "SHA-256 does not match");
    }
    await this.state.storage.deleteAll();
    return json({ collected: true, sha256 });
  }

  private async destroy(role: string | null): Promise<Response> {
    this.requireRole(role, "creator");
    await this.state.storage.deleteAll();
    return json({ destroyed: true });
  }

  private getMeta(): MetaRow | null {
    try {
      return [...this.sql.exec<MetaRow>("SELECT * FROM meta LIMIT 1")][0] ?? null;
    } catch {
      return null;
    }
  }

  private requireMeta(): MetaRow {
    const meta = this.getMeta();
    if (!meta) throw new HttpError(410, "room_gone", "Room no longer exists");
    return meta;
  }

  private requireCurrentOpenRoom(): MetaRow {
    const meta = this.requireMeta();
    if (meta.expires_at <= Date.now()) throw new HttpError(410, "room_gone", "Room no longer exists");
    if (meta.state !== "open") throw new HttpError(409, "room_finalized", "Room is finalized");
    return meta;
  }

  private messageCount(): number {
    return [...this.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM messages")][0]?.count ?? 0;
  }

  private messageBytes(): number {
    return [...this.sql.exec<CountRow>("SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS count FROM messages")][0]?.count ?? 0;
  }

  private messagesAfter(after: number): RoomMessage[] {
    const rows = [...this.sql.exec<MessageRow>(
      "SELECT number, role, text, created_at FROM messages WHERE number > ? ORDER BY number ASC LIMIT ?",
      after,
      MAX_MESSAGES_PER_RESPONSE,
    )];
    const messages: RoomMessage[] = [];
    let totalBytes = 0;
    for (const row of rows) {
      const textBytes = new TextEncoder().encode(row.text).byteLength;
      if (messages.length > 0 && totalBytes + textBytes > MAX_MESSAGE_RESPONSE_BYTES) break;
      messages.push(mapMessage(row));
      totalBytes += textBytes;
    }
    return messages;
  }

  private requireParticipant(role: string | null): ParticipantRole {
    if (!isParticipantRole(role)) throw new HttpError(403, "forbidden", "Participant invite required");
    return role;
  }

  private requireReader(role: string | null): InviteRole {
    if (!isReaderRole(role)) throw new HttpError(403, "forbidden", "Room invite required");
    return role;
  }

  private requireRole(role: string | null, expected: "creator"): void {
    if (role !== expected) throw new HttpError(403, "forbidden", `${expected} invite required`);
  }
}

function mapMessage(row: MessageRow): RoomMessage {
  return { number: row.number, role: row.role, text: row.text, created_at: new Date(row.created_at).toISOString() };
}

function parseBoundedInteger(value: string | null, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/u.test(value)) throw new HttpError(400, "invalid_request", `${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, "invalid_request", `${name} is outside the allowed range`);
  }
  return parsed;
}

function assertFields(body: Record<string, unknown>, allowedFields: string[]): void {
  const allowed = new Set(allowedFields);
  const unexpected = Object.keys(body).find((field) => !allowed.has(field));
  if (unexpected) throw new HttpError(400, "invalid_request", `Unexpected field: ${unexpected}`);
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

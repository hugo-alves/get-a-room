import {
  HttpError,
  MAX_FINAL_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES,
  MAX_TASK_BYTES,
  errorResponse,
  isParticipantRole,
  json,
  readJson,
  requiredString,
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
    const body = await readJson(request);
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
    return json({
      room_id: meta.room_id,
      status: meta.state,
      created_at: new Date(meta.created_at).toISOString(),
      expires_at: new Date(meta.expires_at).toISOString(),
      message_count: count,
      message_limit: MAX_MESSAGES,
      last_number: count,
      has_final: meta.final_sha256 !== null,
    });
  }

  private task(meta: MetaRow, role: string | null): Response {
    this.requireParticipant(role);
    return json({ task: meta.task });
  }

  private async messages(url: URL, role: string | null): Promise<Response> {
    this.requireParticipant(role);
    const after = parseBoundedInteger(url.searchParams.get("after"), "after", 0, Number.MAX_SAFE_INTEGER, 0);
    const wait = parseBoundedInteger(url.searchParams.get("wait"), "wait", 0, 20, 0);
    const deadline = Date.now() + wait * 1000;
    let messages = this.messagesAfter(after);
    while (messages.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      const meta = this.requireMeta();
      if (meta.expires_at <= Date.now()) {
        await this.state.storage.deleteAll();
        throw new HttpError(410, "room_gone", "Room no longer exists");
      }
      messages = this.messagesAfter(after);
    }
    return json({ messages });
  }

  private async addMessage(request: Request, meta: MetaRow, roleValue: string | null): Promise<Response> {
    const role = this.requireParticipant(roleValue);
    if (meta.state !== "open") throw new HttpError(409, "room_finalized", "Room is finalized");
    const body = await readJson(request);
    const text = requiredString(body.text, "text", MAX_MESSAGE_BYTES);
    this.requireCurrentOpenRoom();
    if (this.messageCount() >= MAX_MESSAGES) throw new HttpError(409, "message_limit", "Message limit reached");
    const createdAt = Date.now();
    this.sql.exec("INSERT INTO messages (role, text, created_at) VALUES (?, ?, ?)", role, text, createdAt);
    const row = [...this.sql.exec<MessageRow>("SELECT number, role, text, created_at FROM messages ORDER BY number DESC LIMIT 1")][0];
    if (!row) throw new Error("Inserted message was not found");
    return json({ message: mapMessage(row) }, 201);
  }

  private async submitFinal(request: Request, meta: MetaRow, role: string | null): Promise<Response> {
    this.requireRole(role, "proposer");
    if (meta.state !== "open") throw new HttpError(409, "room_finalized", "Room is already finalized");
    const body = await readJson(request);
    const markdown = requiredString(body.markdown, "markdown", MAX_FINAL_BYTES);
    const sha256 = await digest(markdown);
    this.requireCurrentOpenRoom();
    this.sql.exec("UPDATE meta SET state = 'finalized', final_markdown = ?, final_sha256 = ?", markdown, sha256);
    return json({ sha256 }, 201);
  }

  private getFinal(meta: MetaRow, role: string | null): Response {
    this.requireRole(role, "creator");
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
    const body = await readJson(request);
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

  private messagesAfter(after: number): RoomMessage[] {
    return [...this.sql.exec<MessageRow>(
      "SELECT number, role, text, created_at FROM messages WHERE number > ? ORDER BY number ASC",
      after,
    )].map(mapMessage);
  }

  private requireParticipant(role: string | null): ParticipantRole {
    if (!isParticipantRole(role)) throw new HttpError(403, "forbidden", "Participant invite required");
    return role;
  }

  private requireRole(role: string | null, expected: "creator" | "proposer"): void {
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

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

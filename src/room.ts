import {
  HttpError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_ROOM,
  MAX_CONCURRENT_LONG_POLLS,
  MAX_FINAL_BYTES,
  MAX_LONG_POLL_SECONDS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_RESPONSE_BYTES,
  MAX_MESSAGES_PER_RESPONSE,
  MAX_MESSAGES_PER_ROOM,
  MAX_TOTAL_MESSAGE_BYTES,
  MAX_TASK_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  errorResponse,
  isParticipantRole,
  isReaderRole,
  json,
  readJson,
  requiredString,
  type Env,
  type InviteRole,
  type ParticipantRole,
  type RoomAttachment,
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

interface AttachmentRow extends Record<string, SqlStorageValue> {
  id: string;
  role: ParticipantRole;
  object_key: string;
  filename: string;
  media_type: string;
  size: number;
  sha256: string;
  created_at: number;
  message_number: number | null;
}

export class Room implements DurableObject {
  private readonly sql: SqlStorage;
  private activeLongPolls = 0;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
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
    if (meta) await this.deleteRoomStorage();
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/_initialize") return this.initialize(request);

    const meta = this.requireMeta();
    this.ensureAttachmentsTable();
    if (meta.expires_at <= Date.now()) {
      await this.deleteRoomStorage();
      throw new HttpError(410, "room_gone", "Room no longer exists");
    }

    const role = request.headers.get("x-room-role");
    if (request.method === "GET" && url.pathname === "/status") return this.status(meta);
    if (request.method === "GET" && url.pathname === "/task") return this.task(meta, role);
    if (request.method === "GET" && url.pathname === "/messages") return this.messages(url, role);
    if (request.method === "POST" && url.pathname === "/messages") return this.addMessage(request, meta, role);
    if (request.method === "POST" && url.pathname === "/attachments") return this.addAttachment(request, meta, role);
    if (request.method === "GET" && url.pathname === "/attachments") return this.listAttachments(role);
    if (request.method === "GET" && url.pathname.startsWith("/attachments/")) {
      return this.getAttachment(url.pathname.slice("/attachments/".length), role);
    }
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
    this.ensureAttachmentsTable();
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
      attachment_count: this.attachmentCount(),
      attachment_bytes: this.attachmentBytes(),
      attachment_bytes_limit: MAX_TOTAL_ATTACHMENT_BYTES,
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
          await this.deleteRoomStorage();
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
    assertFields(body, ["text", "attachment_ids"]);
    const attachmentIds = parseAttachmentIds(body.attachment_ids);
    const text = body.text === undefined
      ? ""
      : requiredString(body.text, "text", MAX_MESSAGE_BYTES, { allowEmpty: true });
    if (text.length === 0 && attachmentIds.length === 0) {
      throw new HttpError(400, "invalid_request", "Message text or an attachment is required");
    }
    const attachments = attachmentIds.map((id) => this.requireAttachable(id, role));
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
    this.state.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO messages (role, text, created_at) VALUES (?, ?, ?)", role, text, createdAt);
      const number = [...this.sql.exec<CountRow>("SELECT last_insert_rowid() AS count")][0]?.count;
      if (!number) throw new Error("Inserted message number was not found");
      for (const attachment of attachments) {
        this.sql.exec("UPDATE attachments SET message_number = ? WHERE id = ? AND message_number IS NULL", number, attachment.id);
      }
    });
    const row = [...this.sql.exec<MessageRow>("SELECT number, role, text, created_at FROM messages ORDER BY number DESC LIMIT 1")][0];
    if (!row) throw new Error("Inserted message was not found");
    return json({ message: this.mapMessage(row) }, 201);
  }

  private async addAttachment(request: Request, meta: MetaRow, roleValue: string | null): Promise<Response> {
    const role = this.requireParticipant(roleValue);
    if (meta.state !== "open") throw new HttpError(409, "room_finalized", "Room is finalized");
    const rawLength = request.headers.get("content-length") ?? request.headers.get("x-get-a-room-size");
    if (rawLength === null || !/^\d+$/u.test(rawLength)) {
      throw new HttpError(411, "length_required", "Attachment size is required");
    }
    const size = Number(rawLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) {
      throw new HttpError(413, "attachment_too_large", "Attachment exceeds the size limit");
    }
    if (this.attachmentCount() >= MAX_ATTACHMENTS_PER_ROOM) {
      throw new HttpError(413, "room_attachment_count_exceeded", "Room attachment count limit exceeded");
    }
    if (this.attachmentBytes() + size > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new HttpError(413, "room_attachment_budget_exceeded", "Cumulative room attachment budget exceeded");
    }
    const filename = decodeFilename(request.headers.get("x-get-a-room-filename"));
    const mediaType = validateMediaType(request.headers.get("content-type"));
    const sha256 = request.headers.get("x-get-a-room-sha256")?.toLowerCase() ?? "";
    if (!/^[0-9a-f]{64}$/u.test(sha256)) {
      throw new HttpError(400, "invalid_request", "A valid x-get-a-room-sha256 header is required");
    }
    const id = `a_${randomHex(12)}`;
    const objectKey = `rooms/${meta.room_id}/${id}`;
    let stored: R2Object;
    try {
      stored = await this.env.FILES.put(objectKey, request.body ?? new Uint8Array(), {
        sha256: hexBytes(sha256),
        httpMetadata: { contentType: mediaType },
        customMetadata: { room_id: meta.room_id, attachment_id: id },
      });
    } catch {
      throw new HttpError(400, "attachment_integrity_failed", "Attachment upload failed its integrity check");
    }
    if (stored.size !== size) {
      await this.env.FILES.delete(objectKey);
      throw new HttpError(400, "attachment_size_mismatch", "Attachment size does not match Content-Length");
    }
    const createdAt = Date.now();
    try {
      this.requireCurrentOpenRoom();
      this.sql.exec(
        "INSERT INTO attachments (id, role, object_key, filename, media_type, size, sha256, created_at, message_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        id,
        role,
        objectKey,
        filename,
        mediaType,
        size,
        sha256,
        createdAt,
      );
    } catch (error) {
      await this.env.FILES.delete(objectKey);
      throw error;
    }
    return json({ attachment: mapAttachment({
      id, role, object_key: objectKey, filename, media_type: mediaType, size, sha256, created_at: createdAt, message_number: null,
    }) }, 201);
  }

  private listAttachments(role: string | null): Response {
    this.requireReader(role);
    const rows = [...this.sql.exec<AttachmentRow>(
      "SELECT * FROM attachments WHERE message_number IS NOT NULL ORDER BY message_number, created_at",
    )];
    return json({ attachments: rows.map(mapAttachment) });
  }

  private async getAttachment(id: string, role: string | null): Promise<Response> {
    this.requireReader(role);
    if (!/^a_[0-9a-f]{24}$/u.test(id)) throw new HttpError(404, "not_found", "Attachment not found");
    const row = [...this.sql.exec<AttachmentRow>(
      "SELECT * FROM attachments WHERE id = ? AND message_number IS NOT NULL LIMIT 1",
      id,
    )][0];
    if (!row) throw new HttpError(404, "not_found", "Attachment not found");
    const object = await this.env.FILES.get(row.object_key);
    if (!object?.body) throw new HttpError(410, "attachment_gone", "Attachment no longer exists");
    return new Response(object.body, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        "content-length": String(row.size),
        "content-type": row.media_type,
        "x-content-sha256": row.sha256,
        "x-content-type-options": "nosniff",
      },
    });
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
      await this.deleteRoomStorage();
      throw new HttpError(410, "room_gone", "Room no longer exists");
    }
    if (current.state !== "finalized" || current.final_sha256 === null) {
      throw new HttpError(409, "final_not_ready", "Final result is not ready");
    }
    if (!/^[0-9a-f]{64}$/u.test(sha256) || sha256 !== current.final_sha256) {
      throw new HttpError(409, "sha256_mismatch", "SHA-256 does not match");
    }
    await this.deleteRoomStorage();
    return json({ collected: true, sha256 });
  }

  private async destroy(role: string | null): Promise<Response> {
    this.requireRole(role, "creator");
    await this.deleteRoomStorage();
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

  private attachmentCount(): number {
    return [...this.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM attachments")][0]?.count ?? 0;
  }

  private attachmentBytes(): number {
    return [...this.sql.exec<CountRow>("SELECT COALESCE(SUM(size), 0) AS count FROM attachments")][0]?.count ?? 0;
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
      messages.push(this.mapMessage(row));
      totalBytes += textBytes;
    }
    return messages;
  }

  private mapMessage(row: MessageRow): RoomMessage {
    const attachments = [...this.sql.exec<AttachmentRow>(
      "SELECT * FROM attachments WHERE message_number = ? ORDER BY created_at, id",
      row.number,
    )].map(mapAttachment);
    return { number: row.number, role: row.role, text: row.text, created_at: new Date(row.created_at).toISOString(), attachments };
  }

  private requireAttachable(id: string, role: ParticipantRole): AttachmentRow {
    const row = [...this.sql.exec<AttachmentRow>("SELECT * FROM attachments WHERE id = ? LIMIT 1", id)][0];
    if (!row || row.role !== role || row.message_number !== null) {
      throw new HttpError(400, "invalid_attachment", "Attachment is unavailable for this message");
    }
    return row;
  }

  private ensureAttachmentsTable(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL,
      media_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
      message_number INTEGER
    )`);
  }

  private async deleteRoomStorage(): Promise<void> {
    this.ensureAttachmentsTable();
    const keys = [...this.sql.exec<AttachmentRow>("SELECT * FROM attachments")].map((row) => row.object_key);
    if (keys.length > 0) await this.env.FILES.delete(keys);
    await this.state.storage.deleteAll();
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

function mapAttachment(row: AttachmentRow): RoomAttachment {
  return {
    id: row.id,
    filename: row.filename,
    media_type: row.media_type,
    size: row.size,
    sha256: row.sha256,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function parseAttachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new HttpError(400, "invalid_request", `attachment_ids must contain at most ${MAX_ATTACHMENTS_PER_MESSAGE} items`);
  }
  const ids = value.map((item) => {
    if (typeof item !== "string" || !/^a_[0-9a-f]{24}$/u.test(item)) {
      throw new HttpError(400, "invalid_request", "attachment_ids contains an invalid attachment ID");
    }
    return item;
  });
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "invalid_request", "attachment_ids must be unique");
  return ids;
}

function decodeFilename(value: string | null): string {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new HttpError(400, "invalid_request", "A valid filename header is required");
  let filename: string;
  try {
    const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    filename = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new HttpError(400, "invalid_request", "The filename header is invalid");
  }
  const bytes = new TextEncoder().encode(filename).byteLength;
  const hasUnsafeCharacter = [...filename].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return character === "/" || character === "\\" || codePoint <= 31 || codePoint === 127;
  });
  if (bytes === 0 || bytes > 255 || filename === "." || filename === ".." || hasUnsafeCharacter) {
    throw new HttpError(400, "invalid_request", "The filename is unsafe");
  }
  return filename;
}

function validateMediaType(value: string | null): string {
  const mediaType = (value ?? "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType) || mediaType.length > 127) {
    throw new HttpError(400, "invalid_request", "Content-Type is invalid");
  }
  return mediaType;
}

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
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

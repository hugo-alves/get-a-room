export const DEFAULT_GET_A_ROOM_URL = "https://getaroom.run";

export type InviteRole = "creator" | "guest" | "observer";
export type ParticipantRole = "creator" | "guest";
export type RoomState = "open" | "finalized" | "destroyed";

export interface RoomAccess {
  roomId: string;
  capability: string;
  role?: InviteRole;
}

export interface ParsedInvitation extends RoomAccess {
  baseUrl: string;
  role: InviteRole;
}

export interface CreateRoomOptions {
  task: string;
  ttlSeconds?: number;
}

export interface CreatedRoom {
  room_id: string;
  expires_at: string;
  creator_capability: string;
  lead_invitation_url: string;
  lead_invitation_message: string;
  guest_invitation_url: string;
  guest_invitation_message: string;
  observer_url: string;
  observer_message: string;
}

export interface RoomStatus {
  room_id: string;
  status: RoomState;
  created_at: string;
  expires_at: string;
  message_count: number;
  message_bytes: number;
  message_bytes_limit: number;
  attachment_count: number;
  attachment_bytes: number;
  attachment_bytes_limit: number;
  last_number: number;
  has_final: boolean;
}

export interface RoomMessage {
  number: number;
  role: ParticipantRole;
  text: string;
  created_at: string;
  attachments: RoomAttachment[];
}

export interface RoomAttachment {
  id: string;
  filename: string;
  media_type: string;
  size: number;
  sha256: string;
  created_at: string;
}

export interface UploadAttachmentOptions {
  filename: string;
  bytes: Uint8Array | ArrayBuffer;
  mediaType?: string;
}

export interface RoomFinal {
  markdown: string;
  sha256: string;
}

export interface GetARoomClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class GetARoomError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "GetARoomError";
  }
}

export class GetARoomClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: GetARoomClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_GET_A_ROOM_URL);
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (typeof this.fetcher !== "function") throw new GetARoomError("A fetch implementation is required");
  }

  parseInvitation(value: string): ParsedInvitation {
    const match = /https?:\/\/[^\s<>"']+\/join#invite=[^\s<>"']+/u.exec(value);
    if (!match) throw new GetARoomError("No Get A Room invitation link was found");
    let url: URL;
    try {
      url = new URL(match[0].replace(/[),.;]+$/u, ""));
    } catch {
      throw new GetARoomError("The Get A Room invitation link is invalid");
    }
    const basePath = url.pathname.slice(0, -"/join".length).replace(/\/$/u, "");
    const baseUrl = normalizeBaseUrl(`${url.origin}${basePath}`);
    if (baseUrl !== this.baseUrl) {
      throw new GetARoomError(`The invitation host does not match the configured service: ${this.baseUrl}`);
    }
    const capability = new URLSearchParams(url.hash.slice(1)).get("invite");
    if (!capability) throw new GetARoomError("The invitation is missing its capability");
    const claims = invitationClaims(capability);
    return { baseUrl, roomId: claims.room_id, capability, role: claims.role };
  }

  createRoom(options: CreateRoomOptions): Promise<CreatedRoom> {
    const body: Record<string, unknown> = { task: options.task };
    if (options.ttlSeconds !== undefined) body.ttl_seconds = options.ttlSeconds;
    return this.request("/v1/rooms", { method: "POST", body: JSON.stringify(body) });
  }

  status(access: RoomAccess): Promise<RoomStatus> {
    return this.roomRequest(access, "status");
  }

  async task(access: RoomAccess): Promise<string> {
    const value = await this.roomRequest<{ task: string }>(access, "task");
    return value.task;
  }

  async messages(
    access: RoomAccess,
    options: { after?: number; waitSeconds?: number } = {},
  ): Promise<RoomMessage[]> {
    const after = boundedInteger(options.after ?? 0, "after", 0, Number.MAX_SAFE_INTEGER);
    const wait = boundedInteger(options.waitSeconds ?? 0, "waitSeconds", 0, 5);
    const query = new URLSearchParams({ after: String(after), wait: String(wait) });
    const value = await this.roomRequest<{ messages: RoomMessage[] }>(access, `messages?${query.toString()}`);
    return value.messages;
  }

  async sendMessage(access: RoomAccess, text: string, attachmentIds: string[] = []): Promise<RoomMessage> {
    const value = await this.roomRequest<{ message: RoomMessage }>(access, "messages", {
      method: "POST",
      body: JSON.stringify({ text, ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}) }),
    });
    return value.message;
  }

  async attachments(access: RoomAccess): Promise<RoomAttachment[]> {
    const value = await this.roomRequest<{ attachments: RoomAttachment[] }>(access, "attachments");
    return value.attachments;
  }

  async uploadAttachment(access: RoomAccess, options: UploadAttachmentOptions): Promise<RoomAttachment> {
    const source = options.bytes instanceof Uint8Array ? options.bytes : new Uint8Array(options.bytes);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    const bytes = copy.buffer;
    const sha256 = await digestHex(bytes);
    const value = await this.roomRequest<{ attachment: RoomAttachment }>(access, "attachments", {
      method: "POST",
      headers: {
        "content-type": options.mediaType ?? "application/octet-stream",
        "x-get-a-room-filename": encodeBase64Url(options.filename),
        "x-get-a-room-sha256": sha256,
        "x-get-a-room-size": String(bytes.byteLength),
      },
      body: bytes,
    });
    return value.attachment;
  }

  async downloadAttachment(access: RoomAccess, attachment: RoomAttachment): Promise<Uint8Array> {
    if (!/^a_[0-9a-f]{24}$/u.test(attachment.id)) throw new GetARoomError("The attachment ID is invalid");
    const headers = new Headers({ authorization: `Bearer ${access.capability}` });
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.baseUrl}/v1/rooms/${encodeURIComponent(access.roomId)}/attachments/${encodeURIComponent(attachment.id)}`,
        { headers },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "network request failed";
      throw new GetARoomError(redact(`Attachment download failed: ${detail}`, [access.capability]));
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GetARoomError(`Attachment download failed (HTTP ${response.status})`, response.status);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== attachment.size || await digestHex(bytes) !== attachment.sha256) {
      throw new GetARoomError("Attachment download failed its integrity check");
    }
    return bytes;
  }

  async submitFinal(access: RoomAccess, markdown: string): Promise<string> {
    const value = await this.roomRequest<{ sha256: string }>(access, "final", {
      method: "POST",
      body: JSON.stringify({ markdown }),
    });
    return value.sha256;
  }

  getFinal(access: RoomAccess): Promise<RoomFinal> {
    return this.roomRequest(access, "final");
  }

  async collect(access: RoomAccess, sha256: string): Promise<void> {
    await this.roomRequest(access, "collect", {
      method: "POST",
      body: JSON.stringify({ sha256 }),
    });
  }

  async close(access: RoomAccess): Promise<void> {
    await this.roomRequest(access, "", { method: "DELETE" });
  }

  private roomRequest<T>(access: RoomAccess, action: string, init: RequestInit = {}): Promise<T> {
    if (!/^[0-9a-f]{32}$/u.test(access.roomId)) throw new GetARoomError("The room ID is invalid");
    if (!access.capability) throw new GetARoomError("A room capability is required");
    const suffix = action ? `/${action}` : "";
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${access.capability}`);
    return this.request(`/v1/rooms/${access.roomId}${suffix}`, { ...init, headers }, [access.capability]);
  }

  private async request<T>(path: string, init: RequestInit, secrets: string[] = []): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "network request failed";
      throw new GetARoomError(redact(`Request failed: ${detail}`, secrets));
    }
    const raw = await response.text();
    let body: unknown = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        throw new GetARoomError(`The service returned invalid JSON (HTTP ${response.status})`, response.status);
      }
    }
    if (!response.ok) {
      const record = isRecord(body) ? body : {};
      const code = typeof record.error === "string" ? record.error : undefined;
      const detail = typeof record.message === "string" ? record.message : `HTTP ${response.status}`;
      throw new GetARoomError(
        redact(detail, secrets),
        response.status,
        code,
        response.headers.get("retry-after") ?? undefined,
      );
    }
    return body as T;
  }
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GetARoomError("The Get A Room service URL is invalid");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new GetARoomError("The Get A Room service must use HTTPS except for loopback development");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function invitationClaims(capability: string): { room_id: string; role: InviteRole } {
  const payload = capability.split(".")[0];
  if (!payload || !/^[A-Za-z0-9_-]+$/u.test(payload)) throw new GetARoomError("The invitation is invalid");
  try {
    const padded = payload.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - (payload.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (!/^[0-9a-f]{32}$/u.test(String(claims.room_id))) throw new Error("invalid room");
    if (claims.role !== "creator" && claims.role !== "guest" && claims.role !== "observer") throw new Error("invalid role");
    return { room_id: String(claims.room_id), role: claims.role };
  } catch {
    throw new GetARoomError("The invitation is invalid");
  }
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new GetARoomError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function redact(value: string, secrets: string[]): string {
  let output = value;
  for (const secret of secrets) if (secret) output = output.split(secret).join("[REDACTED]");
  return output.replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]");
}

async function digestHex(value: ArrayBuffer | Uint8Array): Promise<string> {
  const source = value instanceof Uint8Array ? value : new Uint8Array(value);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

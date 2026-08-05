export const MAX_MESSAGE_BYTES = 128 * 1024;
export const MAX_TOTAL_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_MESSAGES_PER_ROOM = 1000;
export const MAX_MESSAGES_PER_RESPONSE = 100;
export const MAX_MESSAGE_RESPONSE_BYTES = 512 * 1024;
export const MAX_LONG_POLL_SECONDS = 5;
export const MAX_CONCURRENT_LONG_POLLS = 2;
export const MAX_TASK_BYTES = 1024 * 1024;
export const MAX_FINAL_BYTES = 2 * 1024 * 1024;
export const MIN_TTL_SECONDS = 15 * 60;
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const CREATION_RATE_LIMIT_MAX = 10;
export const CREATION_RATE_LIMIT_WINDOW_SECONDS = 60;
export const ROOM_REQUEST_RATE_LIMIT_MAX = 180;
export const ROOM_REQUEST_RATE_LIMIT_WINDOW_SECONDS = 60;

export type InviteRole = "creator" | "guest" | "observer";
export type ParticipantRole = "creator" | "guest";
export type RoomStatus = "open" | "finalized" | "destroyed";

export interface Env {
  ROOMS: DurableObjectNamespace;
  ROOM_SIGNING_SECRET: string;
  ROOM_CREATION_RATE_LIMITER: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
  ROOM_REQUEST_RATE_LIMITER: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
  PUBLIC_BASE_URL?: string;
}

export interface InviteClaims {
  room_id: string;
  role: InviteRole;
  iat: number;
  exp: number;
  jti: string;
}

export interface RoomMessage {
  number: number;
  role: ParticipantRole;
  text: string;
  created_at: string;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit | number = 200): Response {
  const responseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(responseInit.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...responseInit, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.code, message: error.message }, { status: error.status, headers: error.headers });
  }
  return json({ error: "internal_error", message: "Internal server error" }, 500);
}

export async function readJson(request: Request, maxBytes = Number.POSITIVE_INFINITY): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/json");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new HttpError(413, "content_too_large", "Request body exceeds the size limit");
  }
  try {
    const reader: ReadableStreamDefaultReader<Uint8Array> = (request.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "content_too_large", "Request body exceeds the size limit");
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object");
  }
}

export function requiredString(
  value: unknown,
  field: string,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", `${field} must be a string`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new HttpError(400, "invalid_request", `${field} must not be empty`);
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new HttpError(413, "content_too_large", `${field} exceeds the size limit`);
  }
  return value;
}

export function isInviteRole(value: unknown): value is InviteRole {
  return value === "creator" || value === "guest" || value === "observer";
}

export function isParticipantRole(value: unknown): value is ParticipantRole {
  return value === "creator" || value === "guest";
}

export function isReaderRole(value: unknown): value is InviteRole {
  return isInviteRole(value);
}

export function roomIdIsValid(value: string): boolean {
  return /^[0-9a-f]{32}$/u.test(value);
}

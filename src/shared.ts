export const MAX_MESSAGES = 12;
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_TASK_BYTES = 256 * 1024;
export const MAX_FINAL_BYTES = 512 * 1024;
export const DEFAULT_TTL_SECONDS = 15 * 60;
export const MAX_TTL_SECONDS = 60 * 60;

export type InviteRole = "creator" | "proposer" | "critic";
export type ParticipantRole = Exclude<InviteRole, "creator">;
export type RoomStatus = "open" | "finalized" | "destroyed";

export interface Env {
  ROOMS: DurableObjectNamespace;
  ROOM_SIGNING_SECRET: string;
  ROOM_CREATOR_KEY: string;
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
    return json({ error: error.code, message: error.message }, error.status);
  }
  return json({ error: "internal_error", message: "Internal server error" }, 500);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/json");
  }
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
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
  return value === "creator" || value === "proposer" || value === "critic";
}

export function isParticipantRole(value: unknown): value is ParticipantRole {
  return value === "proposer" || value === "critic";
}

export function roomIdIsValid(value: string): boolean {
  return /^[0-9a-f]{32}$/u.test(value);
}

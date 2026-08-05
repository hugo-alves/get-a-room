import { HttpError, type InviteClaims, type InviteRole, isInviteRole, roomIdIsValid } from "./shared";

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new HttpError(401, "invalid_invite", "Invalid invite");
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new HttpError(401, "invalid_invite", "Invalid invite");
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (encoder.encode(secret).byteLength < 32) {
    throw new Error("ROOM_SIGNING_SECRET must contain at least 32 bytes");
  }
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createInvite(
  secret: string,
  roomId: string,
  role: InviteRole,
  issuedAt: number,
  expiresAt: number,
): Promise<string> {
  const claims: InviteClaims = {
    room_id: roomId,
    role,
    iat: issuedAt,
    exp: expiresAt,
    jti: crypto.randomUUID(),
  };
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyInvite(secret: string, token: string, expectedRoomId: string): Promise<InviteClaims> {
  const verified = await inspectInvite(secret, token, expectedRoomId);
  if (verified.expired) throw new HttpError(401, "expired_invite", "Invite has expired");
  return verified.claims;
}

export async function inspectInvite(
  secret: string,
  token: string,
  expectedRoomId: string,
): Promise<{ claims: InviteClaims; expired: boolean }> {
  const segments = token.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new HttpError(401, "invalid_invite", "Invalid invite");
  }
  const [payload, encodedSignature] = segments;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    base64UrlDecode(encodedSignature),
    encoder.encode(payload),
  );
  if (!valid) throw new HttpError(401, "invalid_invite", "Invalid invite");

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    throw new HttpError(401, "invalid_invite", "Invalid invite");
  }
  if (!isClaims(claims) || claims.room_id !== expectedRoomId) {
    throw new HttpError(401, "invalid_invite", "Invalid invite");
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.iat > now + 60) throw new HttpError(401, "invalid_invite", "Invalid invite");
  return { claims, expired: claims.exp <= now };
}

function isClaims(value: unknown): value is InviteClaims {
  if (typeof value !== "object" || value === null) return false;
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.room_id === "string" &&
    roomIdIsValid(claims.room_id) &&
    isInviteRole(claims.role) &&
    Number.isInteger(claims.iat) &&
    Number.isInteger(claims.exp) &&
    typeof claims.jti === "string" &&
    claims.jti.length >= 16
  );
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  if (!match) throw new HttpError(401, "missing_invite", "A bearer invite is required");
  return match[1]!;
}

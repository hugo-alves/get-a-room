import { bearerToken, constantTimeEqualText, createInvite, inspectInvite } from "./auth";
import { Room } from "./room";
import {
  DEFAULT_TTL_SECONDS,
  HttpError,
  MAX_TASK_BYTES,
  MAX_TTL_SECONDS,
  errorResponse,
  json,
  readJson,
  requiredString,
  roomIdIsValid,
  type Env,
} from "./shared";

export { Room };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/join") return joinPage();
  if (request.method === "POST" && url.pathname === "/v1/rooms") return createRoom(request, env);

  const match = /^\/v1\/rooms\/([^/]+)(?:\/(status|task|messages|final|collect))?$/u.exec(url.pathname);
  if (!match) throw new HttpError(404, "not_found", "Route not found");
  const roomId = match[1]!;
  const action = match[2] ?? "";
  if (!roomIdIsValid(roomId)) throw new HttpError(404, "not_found", "Room not found");

  const verified = await inspectInvite(env.ROOM_SIGNING_SECRET, bearerToken(request), roomId);
  const claims = verified.claims;
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  if (verified.expired) {
    const probe = await stub.fetch("https://room.internal/status", { headers: { "x-room-role": claims.role } });
    if (probe.status === 410) return probe;
    throw new HttpError(401, "expired_invite", "Invite has expired");
  }
  const allowed =
    (request.method === "GET" && ["status", "task", "messages", "final"].includes(action)) ||
    (request.method === "POST" && ["messages", "final", "collect"].includes(action)) ||
    (request.method === "DELETE" && action === "");
  if (!allowed) throw new HttpError(404, "not_found", "Route not found");

  const internalPath = action === "" ? "/" : `/${action}`;
  const internalUrl = new URL(request.url);
  internalUrl.pathname = internalPath;
  const headers = new Headers(request.headers);
  headers.set("x-room-role", claims.role);
  headers.delete("authorization");
  const forwarded = new Request(internalUrl, { method: request.method, headers, body: request.body, redirect: "manual" });
  return stub.fetch(forwarded);
}

function joinPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Get A Room</title>
  <style>
    :root { color-scheme: light; font: 18px/1.55 system-ui, sans-serif; background: #f4f1ea; color: #191713; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { width: min(36rem, calc(100% - 3rem)); padding: 3rem 0; }
    h1 { font-size: clamp(2.5rem, 10vw, 5rem); line-height: .95; letter-spacing: -.06em; margin: 0 0 2rem; }
    p { max-width: 31rem; }
    .note { border-left: 4px solid #eb5e28; padding-left: 1rem; }
  </style>
</head>
<body><main>
  <h1>Get A Room</h1>
  <p>Your private agent collaboration invitation is ready.</p>
  <p class="note"><strong>Give the complete invitation to your agent.</strong> Keep the full link intact. The private part stays in your browser address and is never sent to this page.</p>
  <p>You can close this page after your agent joins.</p>
</main></body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  const suppliedKey =
    request.headers.get("x-room-creator-key") ?? request.headers.get("x-creator-key") ?? optionalBearer(request);
  if (!suppliedKey || !(await constantTimeEqualText(suppliedKey, env.ROOM_CREATOR_KEY))) {
    throw new HttpError(401, "invalid_creator_key", "Invalid creator key");
  }
  const body = await readJson(request);
  const task = requiredString(body.task, "task", MAX_TASK_BYTES, { allowEmpty: true });
  const ttlSecondsValue = body.ttl_seconds ?? body.ttl ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSecondsValue) || (ttlSecondsValue as number) < 60 || (ttlSecondsValue as number) > MAX_TTL_SECONDS) {
    throw new HttpError(400, "invalid_ttl", `ttl_seconds must be between 60 and ${MAX_TTL_SECONDS}`);
  }

  const roomId = randomRoomId();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAt + (ttlSecondsValue as number);
  const expiresAtMs = expiresAtSeconds * 1000;
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const initialization = await stub.fetch("https://room.internal/_initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room_id: roomId, task, created_at: issuedAt * 1000, expires_at: expiresAtMs }),
  });
  if (!initialization.ok) throw new HttpError(500, "room_initialization_failed", "Could not initialize room");

  const [creator, proposer, critic] = await Promise.all([
    createInvite(env.ROOM_SIGNING_SECRET, roomId, "creator", issuedAt, expiresAtSeconds),
    createInvite(env.ROOM_SIGNING_SECRET, roomId, "proposer", issuedAt, expiresAtSeconds),
    createInvite(env.ROOM_SIGNING_SECRET, roomId, "critic", issuedAt, expiresAtSeconds),
  ]);
  return json(
    {
      room_id: roomId,
      expires_at: new Date(expiresAtMs).toISOString(),
      invites: { creator, proposer, critic },
    },
    201,
  );
}

function optionalBearer(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  return /^Bearer ([^\s]+)$/u.exec(authorization)?.[1] ?? null;
}

function randomRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

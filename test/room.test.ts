import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createInvite } from "../src/auth";
import {
  CREATION_RATE_LIMIT_MAX,
  MAX_FINAL_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_TASK_BYTES,
  MAX_TOTAL_MESSAGE_BYTES,
  type Env,
} from "../src/shared";

const ORIGIN = "https://room.test";
const SIGNING_SECRET = "test-signing-secret-at-least-32-bytes-long";

interface CreatedRoom {
  room_id: string;
  expires_at: string;
  creator_capability: string;
  guest_invitation_url: string;
  guest_invitation_message: string;
}

interface MessageList {
  messages: Array<{ number: number; role: string; text: string }>;
}

const bindings = env as unknown as Env;
let callerSequence = 1;

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function createRoom(task = "# Task", ttlSeconds = 24 * 60 * 60, callerIp?: string): Promise<CreatedRoom> {
  const response = await createRoomResponse(task, ttlSeconds, callerIp ?? `203.0.113.${callerSequence++}`);
  expect(response.status).toBe(201);
  return response.json<CreatedRoom>();
}

function createRoomResponse(task: string, ttlSeconds: number, callerIp: string): Promise<Response> {
  return workerFetch("/v1/rooms", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": callerIp },
    body: JSON.stringify({ task, ttl_seconds: ttlSeconds }),
  });
}

function authenticated(invite: string, method = "GET", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${invite}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe("temporary agent room", () => {
  it("serves a safe branded join page without accepting invitation data", async () => {
    const response = await workerFetch("/join");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    await expect(response.text()).resolves.toContain("Get A Room");
  });

  it("permanently redirects www to the canonical apex domain", async () => {
    const response = await SELF.fetch(new Request("https://www.getaroom.run/join?source=test"), { redirect: "manual" });

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://getaroom.run/join?source=test");
  });

  it("creates anonymously and returns creator plus canonical guest invitation", async () => {
    const room = await createRoom("A harmless task");

    expect(room.room_id).toMatch(/^[0-9a-f]{32}$/);
    expect(room.creator_capability).not.toBe("");
    expect(room.guest_invitation_url).toMatch(/^https:\/\/getaroom\.run\/join#invite=/);
    expect(room.guest_invitation_message).toContain(room.guest_invitation_url);
    expect(Date.parse(room.expires_at)).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

    const task = await workerFetch(`/v1/rooms/${room.room_id}/task`, authenticated(room.creator_capability));
    expect(task.status).toBe(200);
    await expect(task.json()).resolves.toEqual({ task: "A harmless task" });
  });

  it("validates anonymous creation before allocating a room", async () => {
    const oversized = await createRoomResponse("x".repeat(MAX_TASK_BYTES + 1), 24 * 60 * 60, "198.51.100.10");
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: "content_too_large" });

    const unexpected = await workerFetch("/v1/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.11" },
      body: JSON.stringify({ task: "ok", ttl_seconds: 3600, creator_key: "legacy" }),
    });
    expect(unexpected.status).toBe(400);
    await expect(unexpected.json()).resolves.toMatchObject({ error: "invalid_request" });

    const short = await createRoomResponse("ok", 60, "198.51.100.12");
    expect(short.status).toBe(400);
    await expect(short.json()).resolves.toMatchObject({ error: "invalid_ttl" });
  });

  it("rate limits anonymous creation with Retry-After", async () => {
    const caller = "198.51.100.20";
    for (let index = 0; index < CREATION_RATE_LIMIT_MAX; index += 1) {
      expect((await createRoomResponse(`task ${index}`, 24 * 60 * 60, caller)).status).toBe(201);
    }
    const limited = await createRoomResponse("one too many", 24 * 60 * 60, caller);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toMatchObject({ error: "creation_rate_limited" });
  });

  it("orders creator and guest messages without a low count cap", async () => {
    const room = await createRoom();
    const guest = new URLSearchParams(new URL(room.guest_invitation_url).hash.slice(1)).get("invite")!;

    for (let index = 0; index < 20; index += 1) {
      const invite = index % 2 === 0 ? room.creator_capability : guest;
      const response = await workerFetch(
        `/v1/rooms/${room.room_id}/messages`,
        authenticated(invite, "POST", { text: `message ${index + 1}` }),
      );
      expect(response.status).toBe(201);
    }

    const response = await workerFetch(`/v1/rooms/${room.room_id}/messages?after=17`, authenticated(guest));
    const body = await response.json<MessageList>();
    expect(body.messages.map(({ number, role }) => ({ number, role }))).toEqual([
      { number: 18, role: "guest" },
      { number: 19, role: "creator" },
      { number: 20, role: "guest" },
    ]);
  });

  it("enforces per-message, cumulative UTF-8, and final-result byte limits", async () => {
    const room = await createRoom();
    const oversizedMessage = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(room.creator_capability, "POST", { text: "x".repeat(MAX_MESSAGE_BYTES + 1) }),
    );
    expect(oversizedMessage.status).toBe(413);

    const chunk = "x".repeat(MAX_MESSAGE_BYTES);
    const chunkCount = MAX_TOTAL_MESSAGE_BYTES / MAX_MESSAGE_BYTES;
    for (let index = 0; index < chunkCount; index += 1) {
      const response = await workerFetch(
        `/v1/rooms/${room.room_id}/messages`,
        authenticated(room.creator_capability, "POST", { text: chunk }),
      );
      expect(response.status).toBe(201);
    }
    const overBudget = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(room.creator_capability, "POST", { text: "é" }),
    );
    expect(overBudget.status).toBe(413);
    await expect(overBudget.json()).resolves.toMatchObject({ error: "room_message_budget_exceeded" });

    const finalRoom = await createRoom();
    const oversizedFinal = await workerFetch(
      `/v1/rooms/${finalRoom.room_id}/final`,
      authenticated(finalRoom.creator_capability, "POST", { markdown: "x".repeat(MAX_FINAL_BYTES + 1) }),
    );
    expect(oversizedFinal.status).toBe(413);
  });

  it("enforces guest role boundaries", async () => {
    const room = await createRoom();
    const guest = new URLSearchParams(new URL(room.guest_invitation_url).hash.slice(1)).get("invite")!;

    const final = await workerFetch(
      `/v1/rooms/${room.room_id}/final`,
      authenticated(guest, "POST", { markdown: "# Not allowed" }),
    );
    expect(final.status).toBe(403);
    const close = await workerFetch(`/v1/rooms/${room.room_id}`, authenticated(guest, "DELETE"));
    expect(close.status).toBe(403);
  });

  it("rejects tampered, expired, and cross-room capabilities", async () => {
    const first = await createRoom();
    const second = await createRoom();
    const [payload, signature] = first.creator_capability.split(".") as [string, string];
    const tampered = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;

    expect((await workerFetch(`/v1/rooms/${first.room_id}/status`, authenticated(tampered))).status).toBe(401);
    expect((await workerFetch(`/v1/rooms/${second.room_id}/status`, authenticated(first.creator_capability))).status).toBe(401);

    const now = Math.floor(Date.now() / 1000);
    const expired = await createInvite(SIGNING_SECRET, first.room_id, "guest", now - 120, now - 60);
    const expiredResponse = await workerFetch(`/v1/rooms/${first.room_id}/status`, authenticated(expired));
    expect(expiredResponse.status).toBe(401);
    await expect(expiredResponse.json()).resolves.toMatchObject({ error: "expired_invite" });
  });

  it("keeps a room after a bad digest, then deletes it after collection", async () => {
    const room = await createRoom();
    const submitted = await workerFetch(
      `/v1/rooms/${room.room_id}/final`,
      authenticated(room.creator_capability, "POST", { markdown: "# Final\n\nVerified." }),
    );
    const { sha256 } = await submitted.json<{ sha256: string }>();

    const mismatch = await workerFetch(
      `/v1/rooms/${room.room_id}/collect`,
      authenticated(room.creator_capability, "POST", { sha256: "0".repeat(64) }),
    );
    expect(mismatch.status).toBe(409);
    expect((await workerFetch(`/v1/rooms/${room.room_id}/final`, authenticated(room.creator_capability))).status).toBe(200);

    const collected = await workerFetch(
      `/v1/rooms/${room.room_id}/collect`,
      authenticated(room.creator_capability, "POST", { sha256 }),
    );
    expect(collected.status).toBe(200);
    expect((await workerFetch(`/v1/rooms/${room.room_id}/status`, authenticated(room.creator_capability))).status).toBe(410);
  });

  it("allows creator close and removes room state", async () => {
    const room = await createRoom();
    expect((await workerFetch(`/v1/rooms/${room.room_id}`, authenticated(room.creator_capability, "DELETE"))).status).toBe(200);
    expect((await workerFetch(`/v1/rooms/${room.room_id}`, authenticated(room.creator_capability, "DELETE"))).status).toBe(410);
  });

  it("runs the Durable Object alarm and removes SQLite state", async () => {
    const roomId = crypto.randomUUID().replaceAll("-", "");
    const stub = bindings.ROOMS.get(bindings.ROOMS.idFromName(roomId));
    const now = Date.now();
    const initialized = await stub.fetch("https://room.internal/_initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, task: "expires", created_at: now, expires_at: now + 60_000 }),
    });
    expect(initialized.status).toBe(201);
    await runDurableObjectAlarm(stub);

    const afterAlarm = await stub.fetch("https://room.internal/status", { headers: { "x-room-role": "creator" } });
    expect(afterAlarm.status).toBe(410);

    const expiredInvite = await createInvite(
      SIGNING_SECRET,
      roomId,
      "creator",
      Math.floor(now / 1000) - 120,
      Math.floor(now / 1000) - 60,
    );
    const publicAfterAlarm = await workerFetch(`/v1/rooms/${roomId}/status`, authenticated(expiredInvite));
    expect(publicAfterAlarm.status).toBe(410);
  });
});

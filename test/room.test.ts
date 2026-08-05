import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createInvite } from "../src/auth";
import { MAX_FINAL_BYTES, MAX_MESSAGE_BYTES, MAX_MESSAGES, MAX_TASK_BYTES, type Env } from "../src/shared";

const ORIGIN = "https://room.test";
const CREATOR_KEY = "test-creator-key-at-least-32-bytes-long";
const SIGNING_SECRET = "test-signing-secret-at-least-32-bytes-long";

interface CreatedRoom {
  room_id: string;
  expires_at: string;
  invites: { creator: string; proposer: string; critic: string };
}

interface MessageList {
  messages: Array<{ number: number; role: string; text: string }>;
}

const bindings = env as unknown as Env;

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function createRoom(task = "# Task", ttlSeconds = 900): Promise<CreatedRoom> {
  const response = await workerFetch("/v1/rooms", {
    method: "POST",
    headers: { "content-type": "application/json", "x-room-creator-key": CREATOR_KEY },
    body: JSON.stringify({ task, ttl_seconds: ttlSeconds }),
  });
  expect(response.status).toBe(201);
  return response.json<CreatedRoom>();
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

  it("creates a room with three distinct, expiring capabilities", async () => {
    const room = await createRoom("A harmless task", 600);

    expect(room.room_id).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(Object.values(room.invites))).toHaveLength(3);
    expect(Date.parse(room.expires_at)).toBeGreaterThan(Date.now());

    const task = await workerFetch(`/v1/rooms/${room.room_id}/task`, authenticated(room.invites.proposer));
    expect(task.status).toBe(200);
    await expect(task.json()).resolves.toEqual({ task: "A harmless task" });
  });

  it("orders messages from proposer and critic and supports after cursors", async () => {
    const room = await createRoom();
    const entries = [
      [room.invites.proposer, "proposal one"],
      [room.invites.critic, "critique one"],
      [room.invites.proposer, "proposal two"],
      [room.invites.critic, "READY"],
    ] as const;

    for (const [invite, text] of entries) {
      const response = await workerFetch(
        `/v1/rooms/${room.room_id}/messages`,
        authenticated(invite, "POST", { text }),
      );
      expect(response.status).toBe(201);
    }

    const response = await workerFetch(
      `/v1/rooms/${room.room_id}/messages?after=1`,
      authenticated(room.invites.critic),
    );
    const body = await response.json<MessageList>();
    expect(body.messages.map(({ number, role, text }) => ({ number, role, text }))).toEqual([
      { number: 2, role: "critic", text: "critique one" },
      { number: 3, role: "proposer", text: "proposal two" },
      { number: 4, role: "critic", text: "READY" },
    ]);
  });

  it("prevents the critic from submitting a final result", async () => {
    const room = await createRoom();
    const response = await workerFetch(
      `/v1/rooms/${room.room_id}/final`,
      authenticated(room.invites.critic, "POST", { markdown: "# Not allowed" }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects tampered, expired, and cross-room invitations", async () => {
    const first = await createRoom();
    const second = await createRoom();
    const tampered = `${first.invites.proposer.slice(0, -1)}${first.invites.proposer.endsWith("a") ? "b" : "a"}`;

    expect((await workerFetch(`/v1/rooms/${first.room_id}/status`, authenticated(tampered))).status).toBe(401);
    expect((await workerFetch(`/v1/rooms/${second.room_id}/status`, authenticated(first.invites.creator))).status).toBe(401);

    const now = Math.floor(Date.now() / 1000);
    const expired = await createInvite(SIGNING_SECRET, first.room_id, "proposer", now - 120, now - 60);
    const expiredResponse = await workerFetch(`/v1/rooms/${first.room_id}/status`, authenticated(expired));
    expect(expiredResponse.status).toBe(401);
    await expect(expiredResponse.json()).resolves.toMatchObject({ error: "expired_invite" });
  });

  it("enforces task, message count, and content-size limits", async () => {
    const oversizedTask = "x".repeat(MAX_TASK_BYTES + 1);
    const taskResponse = await workerFetch("/v1/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", "x-room-creator-key": CREATOR_KEY },
      body: JSON.stringify({ task: oversizedTask, ttl_seconds: 900 }),
    });
    expect(taskResponse.status).toBe(413);

    const room = await createRoom();
    const oversizedMessage = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(room.invites.proposer, "POST", { text: "x".repeat(MAX_MESSAGE_BYTES + 1) }),
    );
    expect(oversizedMessage.status).toBe(413);

    for (let index = 0; index < MAX_MESSAGES; index += 1) {
      const response = await workerFetch(
        `/v1/rooms/${room.room_id}/messages`,
        authenticated(room.invites.proposer, "POST", { text: `message ${index + 1}` }),
      );
      expect(response.status).toBe(201);
    }
    const thirteenth = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(room.invites.critic, "POST", { text: "one too many" }),
    );
    expect(thirteenth.status).toBe(409);

    const finalRoom = await createRoom();
    const oversizedFinal = await workerFetch(
      `/v1/rooms/${finalRoom.room_id}/final`,
      authenticated(finalRoom.invites.proposer, "POST", { markdown: "x".repeat(MAX_FINAL_BYTES + 1) }),
    );
    expect(oversizedFinal.status).toBe(413);
  });

  it("keeps a room after a bad collection digest, then deletes it after a valid one", async () => {
    const room = await createRoom();
    const submitted = await workerFetch(
      `/v1/rooms/${room.room_id}/final`,
      authenticated(room.invites.proposer, "POST", { markdown: "# Final\n\nVerified." }),
    );
    const { sha256 } = await submitted.json<{ sha256: string }>();

    const mismatch = await workerFetch(
      `/v1/rooms/${room.room_id}/collect`,
      authenticated(room.invites.creator, "POST", { sha256: "0".repeat(64) }),
    );
    expect(mismatch.status).toBe(409);
    expect((await workerFetch(`/v1/rooms/${room.room_id}/final`, authenticated(room.invites.creator))).status).toBe(200);

    const collected = await workerFetch(
      `/v1/rooms/${room.room_id}/collect`,
      authenticated(room.invites.creator, "POST", { sha256 }),
    );
    expect(collected.status).toBe(200);
    expect((await workerFetch(`/v1/rooms/${room.room_id}/status`, authenticated(room.invites.creator))).status).toBe(410);
  });

  it("makes destroy idempotently gone", async () => {
    const room = await createRoom();
    expect((await workerFetch(`/v1/rooms/${room.room_id}`, authenticated(room.invites.creator, "DELETE"))).status).toBe(200);
    expect((await workerFetch(`/v1/rooms/${room.room_id}`, authenticated(room.invites.creator, "DELETE"))).status).toBe(410);
  });

  it("runs the real Durable Object alarm and removes SQLite state", async () => {
    const roomId = crypto.randomUUID().replaceAll("-", "");
    const stub = bindings.ROOMS.get(bindings.ROOMS.idFromName(roomId));
    const now = Date.now();
    const initialized = await stub.fetch("https://room.internal/_initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, task: "expires", created_at: now, expires_at: now + 60_000 }),
    });
    expect(initialized.status).toBe(201);
    // A past-due alarm may run immediately during initialization; explicitly
    // drain it when it is still pending, then assert the observable cleanup.
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

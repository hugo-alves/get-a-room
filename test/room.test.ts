import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createInvite } from "../src/auth";
import {
  CREATION_RATE_LIMIT_MAX,
  MAX_ATTACHMENTS_PER_ROOM,
  MAX_FINAL_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_RESPONSE,
  MAX_TASK_BYTES,
  MAX_TOTAL_MESSAGE_BYTES,
  type Env,
} from "../src/shared";

const ORIGIN = "https://room.test";
const SIGNING_SECRET = "test-signing-secret-at-least-32-bytes-long"; // gitleaks:allow

interface CreatedRoom {
  room_id: string;
  expires_at: string;
  creator_capability: string;
  guest_invitation_url: string;
  guest_invitation_message: string;
  lead_invitation_url: string;
  lead_invitation_message: string;
  observer_url: string;
  observer_message: string;
}

function inviteFromUrl(url: string): string {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("invite")!;
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

function agentRequest(body: Record<string, unknown>): Promise<Response> {
  return workerFetch("/v1/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

async function sha256(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("temporary agent room", () => {
  it("serves a minimal health endpoint", async () => {
    const response = await workerFetch("/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true, service: "get-a-room" });
  });

  it("serves a same-origin browser client that reads its invitation from the fragment", async () => {
    const response = await workerFetch("/join");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain("Get A Room");
    expect(html).toContain('location.hash.slice(1)');
    expect(html).toContain('fetch("/v1/agent"');
    expect(html).toContain("Send a message");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
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
    expect(room.guest_invitation_message).toContain("https://getaroom.run/agents/guest.md");
    expect(room.guest_invitation_message.split(room.guest_invitation_url)).toHaveLength(2);
    expect(room.guest_invitation_message.length).toBeLessThan(1_000);
    expect(Date.parse(room.expires_at)).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

    const task = await workerFetch(`/v1/rooms/${room.room_id}/task`, authenticated(room.creator_capability));
    expect(task.status).toBe(200);
    await expect(task.json()).resolves.toEqual({ task: "A harmless task" });
  });

  it("shares an immutable file in an ordered message and deletes it with the room", async () => {
    const room = await createRoom("Review the attached brief");
    const observer = inviteFromUrl(room.observer_url);
    const guest = inviteFromUrl(room.guest_invitation_url);
    const bytes = new TextEncoder().encode("attachment contents");
    const checksum = await sha256(bytes);
    const upload = await workerFetch(`/v1/rooms/${room.room_id}/attachments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${room.creator_capability}`,
        "content-length": String(bytes.byteLength),
        "content-type": "text/plain",
        "x-get-a-room-filename": btoa("brief.txt"),
        "x-get-a-room-sha256": checksum,
      },
      body: bytes,
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json<{ attachment: { id: string; filename: string; sha256: string } }>();
    expect(uploaded.attachment).toMatchObject({ filename: "brief.txt", sha256: checksum });

    const hidden = await workerFetch(`/v1/rooms/${room.room_id}/attachments`, authenticated(observer));
    await expect(hidden.json()).resolves.toEqual({ attachments: [] });

    const wrongRole = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(guest, "POST", { text: "Mine", attachment_ids: [uploaded.attachment.id] }),
    );
    expect(wrongRole.status).toBe(400);

    const sent = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(room.creator_capability, "POST", {
        text: "Initial context",
        attachment_ids: [uploaded.attachment.id],
      }),
    );
    expect(sent.status).toBe(201);
    await expect(sent.json()).resolves.toMatchObject({
      message: {
        number: 1,
        text: "Initial context",
        attachments: [{ id: uploaded.attachment.id, filename: "brief.txt", sha256: checksum }],
      },
    });

    const listed = await workerFetch(`/v1/rooms/${room.room_id}/attachments`, authenticated(observer));
    await expect(listed.json()).resolves.toMatchObject({ attachments: [{ id: uploaded.attachment.id }] });
    const downloaded = await workerFetch(
      `/v1/rooms/${room.room_id}/attachments/${uploaded.attachment.id}`,
      authenticated(observer),
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toContain("attachment");
    expect(downloaded.headers.get("x-content-sha256")).toBe(checksum);
    expect(await downloaded.text()).toBe("attachment contents");

    expect(await bindings.FILES.get(`rooms/${room.room_id}/${uploaded.attachment.id}`)).not.toBeNull();
    const closed = await workerFetch(
      `/v1/rooms/${room.room_id}`,
      authenticated(room.creator_capability, "DELETE"),
    );
    expect(closed.status).toBe(200);
    expect(await bindings.FILES.get(`rooms/${room.room_id}/${uploaded.attachment.id}`)).toBeNull();
  });

  it("rejects unsafe attachment names and checksum mismatches", async () => {
    const room = await createRoom("Inspect a file");
    const bytes = new TextEncoder().encode("safe bytes");
    const baseHeaders = {
      authorization: `Bearer ${room.creator_capability}`,
      "content-length": String(bytes.byteLength),
      "content-type": "application/octet-stream",
      "x-get-a-room-size": String(bytes.byteLength),
    };
    const unsafe = await workerFetch(`/v1/rooms/${room.room_id}/attachments`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "x-get-a-room-filename": btoa("../secret.txt").replace(/=+$/u, ""),
        "x-get-a-room-sha256": await sha256(bytes),
      },
      body: bytes,
    });
    expect(unsafe.status).toBe(400);

    const mismatch = await workerFetch(`/v1/rooms/${room.room_id}/attachments`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "x-get-a-room-filename": btoa("safe.txt").replace(/=+$/u, ""),
        "x-get-a-room-sha256": "0".repeat(64),
      },
      body: bytes,
    });
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({ error: "attachment_integrity_failed" });
  });

  it("keeps concurrent attachment uploads within the room count limit", async () => {
    const room = await createRoom("Inspect concurrent files");
    const bytes = new TextEncoder().encode("x");
    const checksum = await sha256(bytes);
    const upload = (index: number) => workerFetch(`/v1/rooms/${room.room_id}/attachments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${room.creator_capability}`,
        "content-length": String(bytes.byteLength),
        "content-type": "text/plain",
        "x-get-a-room-filename": btoa(`file-${index}.txt`).replace(/=+$/u, ""),
        "x-get-a-room-sha256": checksum,
      },
      body: bytes,
    });

    for (let index = 0; index < MAX_ATTACHMENTS_PER_ROOM - 1; index += 1) {
      expect((await upload(index)).status).toBe(201);
    }
    const competing = await Promise.all([upload(9), upload(10)]);
    expect(competing.map((response) => response.status).sort()).toEqual([201, 413]);

    const status = await workerFetch(`/v1/rooms/${room.room_id}/status`, authenticated(room.creator_capability));
    await expect(status.json()).resolves.toMatchObject({ attachment_count: MAX_ATTACHMENTS_PER_ROOM });
  });

  it("joins, sends, and checks using only the complete invitation URL", async () => {
    const room = await createRoom("Compare the two proposals");
    const invitation = room.guest_invitation_url;
    const credential = inviteFromUrl(invitation);

    const joined = await agentRequest({ action: "join", invitation });
    expect(joined.status).toBe(200);
    const joinedText = await joined.text();
    expect(joinedText).not.toContain(credential);
    expect(JSON.parse(joinedText)).toMatchObject({
      role: "guest",
      task: "Compare the two proposals",
      messages: [],
      next_cursor: 0,
      next_actions: ["say", "check"],
      status: { room_id: room.room_id, status: "open", message_count: 0 },
    });

    const leadJoined = await agentRequest({ action: "join", invitation: room.lead_invitation_url });
    expect(leadJoined.status).toBe(200);
    await expect(leadJoined.json()).resolves.toMatchObject({
      role: "lead",
      task: "Compare the two proposals",
      next_actions: ["say", "check", "finish", "close"],
    });

    const said = await agentRequest({ action: "say", invitation, text: "Guest analysis" });
    expect(said.status).toBe(200);
    await expect(said.json()).resolves.toMatchObject({ role: "guest", message: { number: 1, role: "guest", text: "Guest analysis" } });

    const leadMessage = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(room.creator_capability, "POST", { text: "Lead reply" }),
    );
    expect(leadMessage.status).toBe(201);

    const checked = await agentRequest({ action: "check", invitation, after: 1, wait_seconds: 0 });
    expect(checked.status).toBe(200);
    await expect(checked.json()).resolves.toMatchObject({
      role: "guest",
      messages: [{ number: 2, role: "creator", text: "Lead reply" }],
      next_cursor: 2,
      next_actions: ["say", "check"],
    });
  });

  it("completes the zero-install lead final lifecycle without leaking its invitation", async () => {
    const room = await createRoom("Produce the final answer");
    const invitation = room.lead_invitation_url;
    const credential = inviteFromUrl(invitation);

    const finished = await agentRequest({ action: "finish", invitation, markdown: "# Final answer" });
    expect(finished.status).toBe(200);
    const finishedText = await finished.text();
    expect(finishedText).not.toContain(credential);
    const finishedBody = JSON.parse(finishedText) as { sha256: string; next_actions: string[] };
    expect(finishedBody.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(finishedBody.next_actions).toEqual(["check", "final", "collect", "close"]);

    const rejectedMessage = await agentRequest({ action: "say", invitation, text: "Too late" });
    expect(rejectedMessage.status).toBe(409);
    expect(await rejectedMessage.text()).not.toContain(credential);

    const checked = await agentRequest({ action: "check", invitation, after: 0 });
    expect(checked.status).toBe(200);
    await expect(checked.json()).resolves.toMatchObject({ next_actions: ["check", "final", "collect", "close"] });

    const final = await agentRequest({ action: "final", invitation });
    expect(final.status).toBe(200);
    const finalText = await final.text();
    expect(finalText).not.toContain(credential);
    expect(JSON.parse(finalText)).toMatchObject({ markdown: "# Final answer", sha256: finishedBody.sha256 });

    const wrongDigest = await agentRequest({ action: "collect", invitation, sha256: "0".repeat(64) });
    expect(wrongDigest.status).toBe(409);
    expect(await wrongDigest.text()).not.toContain(credential);
    expect((await agentRequest({ action: "final", invitation })).status).toBe(200);

    const collected = await agentRequest({ action: "collect", invitation, sha256: finishedBody.sha256 });
    expect(collected.status).toBe(200);
    await expect(collected.json()).resolves.toMatchObject({ collected: true, sha256: finishedBody.sha256, next_actions: [] });
    expect((await agentRequest({ action: "join", invitation })).status).toBe(410);
  });

  it("closes through the lead facade and rejects every lead action for guests", async () => {
    const room = await createRoom("Close this room");
    const guestInvitation = room.guest_invitation_url;
    const guestCredential = inviteFromUrl(guestInvitation);
    const attempts = [
      { action: "finish", invitation: guestInvitation, markdown: "not allowed" },
      { action: "final", invitation: guestInvitation },
      { action: "collect", invitation: guestInvitation, sha256: "0".repeat(64) },
      { action: "close", invitation: guestInvitation },
    ];
    for (const attempt of attempts) {
      const response = await agentRequest(attempt);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(guestCredential);
    }

    const closed = await agentRequest({ action: "close", invitation: room.lead_invitation_url });
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toMatchObject({ destroyed: true, next_actions: [] });
    expect((await agentRequest({ action: "join", invitation: room.lead_invitation_url })).status).toBe(410);
  });

  it("keeps agent invitations out of URLs, errors, and responses", async () => {
    const room = await createRoom("Secret-safe facade");
    const invitation = room.guest_invitation_url;
    const credential = inviteFromUrl(invitation);

    const badHost = await agentRequest({ action: "join", invitation: invitation.replace("getaroom.run", "example.com") });
    expect(badHost.status).toBe(400);
    expect(await badHost.text()).not.toContain(credential);

    const unexpected = await agentRequest({ action: "join", invitation, credential });
    expect(unexpected.status).toBe(400);
    expect(await unexpected.text()).not.toContain(credential);

    const observer = await agentRequest({ action: "join", invitation: room.observer_url.replace("/watch#", "/join#") });
    expect(observer.status).toBe(403);
    expect(await observer.text()).not.toContain(inviteFromUrl(room.observer_url));

    const oversized = await agentRequest({ action: "say", invitation, text: "x".repeat(MAX_MESSAGE_BYTES + 1) });
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).not.toContain(credential);
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

  it("paginates transcript reads so one request cannot return the whole room", async () => {
    const room = await createRoom();
    for (let index = 0; index < MAX_MESSAGES_PER_RESPONSE + 5; index += 1) {
      const response = await workerFetch(
        `/v1/rooms/${room.room_id}/messages`,
        authenticated(room.creator_capability, "POST", { text: `message ${index + 1}` }),
      );
      expect(response.status).toBe(201);
    }

    const first = await workerFetch(`/v1/rooms/${room.room_id}/messages?after=0`, authenticated(room.creator_capability));
    const firstBody = await first.json<MessageList>();
    expect(firstBody.messages).toHaveLength(MAX_MESSAGES_PER_RESPONSE);

    const second = await workerFetch(
      `/v1/rooms/${room.room_id}/messages?after=${firstBody.messages.at(-1)!.number}`,
      authenticated(room.creator_capability),
    );
    const secondBody = await second.json<MessageList>();
    expect(secondBody.messages).toHaveLength(5);
  });

  it("enforces per-message, cumulative UTF-8, and final-result byte limits", async () => {
    const room = await createRoom();
    const oversizedMessage = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(room.creator_capability, "POST", { text: "x".repeat(MAX_MESSAGE_BYTES + 1) }),
    );
    expect(oversizedMessage.status).toBe(413);

    const oversizedEnvelope = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(room.creator_capability, "POST", { text: "small", padding: "x".repeat(MAX_MESSAGE_BYTES + 4096) }),
    );
    expect(oversizedEnvelope.status).toBe(413);

    const unexpectedField = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(room.creator_capability, "POST", { text: "small", metadata: "not accepted" }),
    );
    expect(unexpectedField.status).toBe(400);
    await expect(unexpectedField.json()).resolves.toMatchObject({ error: "invalid_request" });

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
    const guest = inviteFromUrl(room.guest_invitation_url);

    const final = await workerFetch(
      `/v1/rooms/${room.room_id}/final`,
      authenticated(guest, "POST", { markdown: "# Not allowed" }),
    );
    expect(final.status).toBe(403);
    const close = await workerFetch(`/v1/rooms/${room.room_id}`, authenticated(guest, "DELETE"));
    expect(close.status).toBe(403);
  });

  it("serves a safe browser page for starting a room", async () => {
    const response = await workerFetch("/new");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    const html = await response.text();
    expect(html).toContain("Copy prompt for my lead agent");
    expect(html).toContain("Create the room manually instead");
    expect(html).toContain('aria-live="polite"');
  });

  it("serves the landing page and its room-plan image", async () => {
    const page = await workerFetch("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("A room is");
    expect(html).toContain('href="/new"');
    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('src="/get-a-room-launch.mp4"');
    expect(html).toContain('href="https://github.com/hugo-alves/get-a-room"');
    expect(page.headers.get("content-security-policy")).toContain("media-src 'self'");
    expect(html).not.toContain("Direction B");

    const favicon = await workerFetch("/favicon.svg");
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toContain("image/svg+xml");

    const plan = await workerFetch("/room-plan.svg");
    expect(plan.status).toBe(200);
    expect(plan.headers.get("content-type")).toContain("image/svg+xml");
    await expect(plan.text()).resolves.toContain("PRIVATE LEAD DOOR");
  });

  it("returns a lead invitation wrapping the creator capability for browser-created rooms", async () => {
    const room = await createRoom();
    expect(room.lead_invitation_url).toMatch(/^https:\/\/getaroom\.run\/join#invite=/);
    expect(inviteFromUrl(room.lead_invitation_url)).toBe(room.creator_capability);
    expect(room.lead_invitation_message).toContain(room.lead_invitation_url);
    expect(room.lead_invitation_message).not.toContain(inviteFromUrl(room.guest_invitation_url));
    expect(room.lead_invitation_message).toContain("https://getaroom.run/agents/lead.md");
    expect(room.lead_invitation_message.split(room.lead_invitation_url)).toHaveLength(2);
    expect(room.lead_invitation_message.length).toBeLessThan(1_000);

    const status = await workerFetch(
      `/v1/rooms/${room.room_id}/status`,
      authenticated(inviteFromUrl(room.lead_invitation_url)),
    );
    expect(status.status).toBe(200);
  });

  it("serves a safe watch page for human observers", async () => {
    const response = await workerFetch("/watch");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    const html = await response.text();
    expect(html).toContain("Observer window");
    expect(html).toContain("Copy final");
    expect(html).toContain("Room deleted");
    expect(html).toContain('message.role === "creator" ? "Lead" : "Guest"');
    expect(html).toContain('crypto.subtle.digest("SHA-256", bytes)');
    expect(html).toContain("sha256 !== attachment.sha256");
  });

  it("returns an observer watch link alongside creator and guest capabilities", async () => {
    const room = await createRoom();
    expect(room.guest_invitation_message).toContain("Get A Room — guest invitation");
    expect(room.observer_url).toMatch(/^https:\/\/getaroom\.run\/watch#invite=/);
    expect(room.observer_message).toContain(room.observer_url);
    expect(room.observer_message).not.toContain(room.creator_capability);
    const observer = inviteFromUrl(room.observer_url);
    expect(observer).not.toBe(room.creator_capability);
    expect(observer).not.toBe(inviteFromUrl(room.guest_invitation_url));
  });

  it("lets an observer read status, task, transcript, and the available final", async () => {
    const room = await createRoom("Observed task");
    const observer = inviteFromUrl(room.observer_url);

    const status = await workerFetch(`/v1/rooms/${room.room_id}/status`, authenticated(observer));
    expect(status.status).toBe(200);

    const task = await workerFetch(`/v1/rooms/${room.room_id}/task`, authenticated(observer));
    expect(task.status).toBe(200);
    await expect(task.json()).resolves.toEqual({ task: "Observed task" });

    const sent = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(room.creator_capability, "POST", { text: "hello guest" }),
    );
    expect(sent.status).toBe(201);
    const messages = await workerFetch(`/v1/rooms/${room.room_id}/messages`, authenticated(observer));
    const body = await messages.json<MessageList>();
    expect(body.messages.map(({ role, text }) => ({ role, text }))).toEqual([{ role: "creator", text: "hello guest" }]);

    const early = await workerFetch(`/v1/rooms/${room.room_id}/final`, authenticated(observer));
    expect(early.status).toBe(409);

    const finalized = await workerFetch(
      `/v1/rooms/${room.room_id}/final`,
      authenticated(room.creator_capability, "POST", { markdown: "# Done" }),
    );
    expect(finalized.status).toBe(201);
    const final = await workerFetch(`/v1/rooms/${room.room_id}/final`, authenticated(observer));
    expect(final.status).toBe(200);
    await expect(final.json()).resolves.toMatchObject({ markdown: "# Done" });

    const guest = inviteFromUrl(room.guest_invitation_url);
    expect((await workerFetch(`/v1/rooms/${room.room_id}/final`, authenticated(guest))).status).toBe(403);
  });

  it("forbids every observer mutation with 403 and reports 410 after closure", async () => {
    const room = await createRoom();
    const observer = inviteFromUrl(room.observer_url);

    const message = await workerFetch(
      `/v1/rooms/${room.room_id}/messages`,
      authenticated(observer, "POST", { text: "not allowed" }),
    );
    expect(message.status).toBe(403);
    const final = await workerFetch(
      `/v1/rooms/${room.room_id}/final`,
      authenticated(observer, "POST", { markdown: "# Not allowed" }),
    );
    expect(final.status).toBe(403);
    const collect = await workerFetch(
      `/v1/rooms/${room.room_id}/collect`,
      authenticated(observer, "POST", { sha256: "0".repeat(64) }),
    );
    expect(collect.status).toBe(403);
    const destroy = await workerFetch(`/v1/rooms/${room.room_id}`, authenticated(observer, "DELETE"));
    expect(destroy.status).toBe(403);

    const closed = await workerFetch(`/v1/rooms/${room.room_id}`, authenticated(room.creator_capability, "DELETE"));
    expect(closed.status).toBe(200);
    expect((await workerFetch(`/v1/rooms/${room.room_id}/status`, authenticated(observer))).status).toBe(410);
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
    expect(publicAfterAlarm.status).toBe(401);
    await expect(publicAfterAlarm.json()).resolves.toMatchObject({ error: "expired_invite" });
  });
});

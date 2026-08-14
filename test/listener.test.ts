import type { GetARoomClient, RoomMessage, RoomStatus } from "../client/index.js";
import {
  listenForRoomActivity,
  WakeNotHandledError,
  type ListenerSession,
  type WakeAdapter,
  type WakeEvent,
} from "../client/listener.js";

import { describe, expect, it, vi } from "vitest";

const CAPABILITY = "private-capability-that-must-not-leave-the-listener";
const ROOM_ID = "0123456789abcdef0123456789abcdef";

function session(overrides: Partial<ListenerSession> = {}): ListenerSession {
  return {
    localSessionId: "s_0123456789abcdef01234567",
    access: { roomId: ROOM_ID, capability: CAPABILITY, role: "creator" },
    role: "lead",
    lastCheckedNumber: 0,
    expiresAt: "2030-01-01T00:00:00.000Z",
    state: "open",
    ...overrides,
  };
}

function noMark(): Promise<void> {
  return Promise.resolve();
}

function message(number: number, role: RoomMessage["role"], text: string): RoomMessage {
  return { number, role, text, created_at: "2026-08-14T12:00:00.000Z", attachments: [] };
}

function status(state: RoomStatus["status"] = "open"): RoomStatus {
  return {
    room_id: ROOM_ID,
    status: state,
    created_at: "2026-08-14T12:00:00.000Z",
    expires_at: "2030-01-01T00:00:00.000Z",
    message_count: 0,
    message_bytes: 0,
    message_bytes_limit: 1,
    attachment_count: 0,
    attachment_bytes: 0,
    attachment_bytes_limit: 1,
    last_number: 0,
    has_final: state === "finalized",
  };
}

function client(
  getMessages: (after: number) => RoomMessage[],
  roomStatus: RoomStatus = status(),
): Pick<GetARoomClient, "messages" | "status"> {
  return {
    status: vi.fn(() => Promise.resolve(roomStatus)),
    messages: vi.fn((_access, options = {}) => Promise.resolve(getMessages(options.after ?? 0))),
  };
}

describe("room activity listener", () => {
  it("wakes only for peer activity and never passes message text or capabilities", async () => {
    let current = session();
    const events: WakeEvent[] = [];
    const adapter: WakeAdapter = {
      wake: (event) => {
        events.push(event);
        current = { ...current, lastCheckedNumber: event.throughCursor };
        return Promise.resolve("accepted");
      },
    };
    const result = await listenForRoomActivity({
      client: client((after) => [
        message(1, "creator", "the listener's own earlier message"),
        message(2, "guest", "untrusted peer instructions"),
      ].filter((item) => item.number > after)),
      loadSession: () => Promise.resolve(current),
      markChecked: noMark,
      adapter,
      once: true,
      waitSeconds: 0,
      now: () => Date.parse("2026-08-14T12:00:00.000Z"),
    });

    expect(result).toEqual({ reason: "handled", throughCursor: 2 });
    expect(events).toEqual([{
      localSessionId: current.localSessionId,
      roomId: ROOM_ID,
      role: "lead",
      afterCursor: 0,
      throughCursor: 2,
    }]);
    expect(JSON.stringify(events)).not.toContain(CAPABILITY);
    expect(JSON.stringify(events)).not.toContain("untrusted peer instructions");
  });

  it("does not wake for the participant's own messages", async () => {
    let current = session();
    const adapter = { wake: vi.fn(() => Promise.resolve("accepted" as const)) };
    const result = await listenForRoomActivity({
      client: client(() => [message(1, "creator", "own message")]),
      loadSession: () => Promise.resolve(current),
      markChecked: (throughCursor) => {
        current = { ...current, lastCheckedNumber: throughCursor };
        return Promise.resolve();
      },
      adapter,
      once: true,
      waitSeconds: 0,
    });

    expect(result).toEqual({ reason: "idle" });
    expect(current.lastCheckedNumber).toBe(1);
    expect(adapter.wake).not.toHaveBeenCalled();
  });

  it("requires the resumed agent to advance the durable cursor", async () => {
    await expect(listenForRoomActivity({
      client: client(() => [message(3, "guest", "pending")]),
      loadSession: () => Promise.resolve(session({ lastCheckedNumber: 1 })),
      markChecked: noMark,
      adapter: { wake: () => Promise.resolve("accepted") },
      once: true,
      waitSeconds: 0,
    })).rejects.toEqual(new WakeNotHandledError(3, 1));
  });

  it("leaves activity pending while the runtime is busy", async () => {
    const result = await listenForRoomActivity({
      client: client(() => [message(4, "guest", "pending")]),
      loadSession: () => Promise.resolve(session({ lastCheckedNumber: 2 })),
      markChecked: noMark,
      adapter: { wake: () => Promise.resolve("busy") },
      once: true,
      waitSeconds: 0,
    });

    expect(result).toEqual({ reason: "busy", throughCursor: 4 });
  });

  it("floors a zero retry setting to prevent a busy-loop", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const wake = vi.fn(() => Promise.resolve("busy" as const));
    try {
      const listening = listenForRoomActivity({
        client: client(() => [message(1, "guest", "pending")]),
        loadSession: () => Promise.resolve(session()),
        markChecked: noMark,
        adapter: { wake },
        waitSeconds: 0,
        retrySeconds: 0,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(wake).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(wake).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(wake).toHaveBeenCalledTimes(2);
      controller.abort();
      await vi.runAllTimersAsync();
      await expect(listening).resolves.toEqual({ reason: "aborted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wake the same activity after a handled restart", async () => {
    let current = session();
    const allMessages = [message(1, "guest", "one")];
    const adapter = {
      wake: vi.fn((event: WakeEvent) => {
        current = { ...current, lastCheckedNumber: event.throughCursor };
        return Promise.resolve("accepted" as const);
      }),
    };
    const options = {
      client: client((after: number) => allMessages.filter((item) => item.number > after)),
      loadSession: () => Promise.resolve(current),
      markChecked: noMark,
      adapter,
      once: true,
      waitSeconds: 0,
    } as const;

    await expect(listenForRoomActivity(options)).resolves.toEqual({ reason: "handled", throughCursor: 1 });
    await expect(listenForRoomActivity(options)).resolves.toEqual({ reason: "idle" });
    expect(adapter.wake).toHaveBeenCalledTimes(1);
  });

  it("stops for finalized, expired, and deleted rooms", async () => {
    const adapter = { wake: vi.fn(() => Promise.resolve("accepted" as const)) };
    await expect(listenForRoomActivity({
      client: client(() => [], status("finalized")),
      loadSession: () => Promise.resolve(session()),
      markChecked: noMark,
      adapter,
      once: true,
    })).resolves.toEqual({ reason: "finalized" });
    await expect(listenForRoomActivity({
      client: client(() => []),
      loadSession: () => Promise.resolve(session({ expiresAt: "2020-01-01T00:00:00.000Z" })),
      markChecked: noMark,
      adapter,
      once: true,
    })).resolves.toEqual({ reason: "expired" });
    await expect(listenForRoomActivity({
      client: {
        status: vi.fn(() => Promise.reject(Object.assign(new Error("gone"), { status: 410 }))),
        messages: vi.fn(),
      },
      loadSession: () => Promise.resolve(session()),
      markChecked: noMark,
      adapter,
      once: true,
    })).resolves.toEqual({ reason: "stopped" });
    expect(adapter.wake).not.toHaveBeenCalled();
  });
});

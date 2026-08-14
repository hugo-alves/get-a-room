import type { GetARoomClient, ParticipantRole, RoomAccess } from "./index.js";

export type WakeOutcome = "accepted" | "busy";

export interface WakeEvent {
  localSessionId: string;
  roomId: string;
  role: "lead" | "guest";
  afterCursor: number;
  throughCursor: number;
}

export interface WakeAdapter {
  wake(event: WakeEvent): Promise<WakeOutcome>;
}

export interface ListenerSession {
  localSessionId: string;
  access: RoomAccess;
  role: "lead" | "guest";
  lastCheckedNumber: number;
  expiresAt: string | null;
  state: "open" | "finished" | "collected" | "closed";
}

export type ListenResult =
  | { reason: "handled"; throughCursor: number }
  | { reason: "idle" }
  | { reason: "busy"; throughCursor: number }
  | { reason: "finalized" }
  | { reason: "expired" }
  | { reason: "stopped" }
  | { reason: "aborted" };

export interface ListenForRoomActivityOptions {
  client: Pick<GetARoomClient, "messages" | "status">;
  loadSession: () => Promise<ListenerSession>;
  markChecked: (throughCursor: number) => Promise<void>;
  adapter: WakeAdapter;
  waitSeconds?: number;
  retrySeconds?: number;
  once?: boolean;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
  now?: () => number;
}

export class WakeNotHandledError extends Error {
  constructor(
    public readonly expectedCursor: number,
    public readonly actualCursor: number,
  ) {
    super(`The wake adapter returned without handling room activity through cursor ${expectedCursor}`);
    this.name = "WakeNotHandledError";
  }
}

export async function listenForRoomActivity(options: ListenForRoomActivityOptions): Promise<ListenResult> {
  const waitSeconds = boundedInteger(options.waitSeconds ?? 5, "waitSeconds", 0, 5);
  const retrySeconds = boundedInteger(options.retrySeconds ?? 2, "retrySeconds", 0, 300);
  const now = options.now ?? Date.now;
  let retryAttempt = 0;

  while (!options.signal?.aborted) {
    const session = await options.loadSession();
    const localStop = localStopReason(session, now());
    if (localStop) return { reason: localStop };

    try {
      const status = await options.client.status(session.access);
      if (status.status !== "open") return { reason: status.status === "finalized" ? "finalized" : "stopped" };

      const found = await options.client.messages(session.access, {
        after: session.lastCheckedNumber,
        waitSeconds,
      });
      const peerRole: ParticipantRole = session.role === "lead" ? "guest" : "creator";
      const peerMessages = found.filter((message) => message.role === peerRole);
      if (peerMessages.length === 0) {
        if (found.length > 0) {
          await options.markChecked(Math.max(...found.map((message) => message.number)));
        }
        retryAttempt = 0;
        if (options.once) return { reason: "idle" };
        if (waitSeconds === 0) await retryDelay(Math.max(retrySeconds, 1), 1, options.signal);
        continue;
      }

      const throughCursor = Math.max(...peerMessages.map((message) => message.number));
      const event: WakeEvent = {
        localSessionId: session.localSessionId,
        roomId: session.access.roomId,
        role: session.role,
        afterCursor: session.lastCheckedNumber,
        throughCursor,
      };
      const outcome = await options.adapter.wake(event);
      if (outcome === "busy") {
        if (options.once) return { reason: "busy", throughCursor };
        retryAttempt += 1;
        await retryDelay(retrySeconds, retryAttempt, options.signal);
        continue;
      }

      const handledSession = await options.loadSession();
      if (handledSession.lastCheckedNumber < throughCursor) {
        throw new WakeNotHandledError(throughCursor, handledSession.lastCheckedNumber);
      }
      retryAttempt = 0;
      if (options.once) return { reason: "handled", throughCursor };
    } catch (error) {
      if (options.signal?.aborted) return { reason: "aborted" };
      if (isRoomGone(error)) return { reason: "stopped" };
      options.onError?.(error);
      if (options.once) throw error;
      retryAttempt += 1;
      await retryDelay(retrySeconds, retryAttempt, options.signal);
    }
  }

  return { reason: "aborted" };
}

function isRoomGone(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 410;
}

function localStopReason(session: ListenerSession, now: number): "expired" | "stopped" | undefined {
  if (session.state !== "open") return "stopped";
  if (session.expiresAt !== null) {
    const expiresAt = Date.parse(session.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) return "expired";
  }
  return undefined;
}

async function retryDelay(seconds: number, attempt: number, signal?: AbortSignal): Promise<void> {
  const milliseconds = Math.min(Math.max(seconds, 1) * 1000 * 2 ** Math.min(attempt - 1, 5), 30_000);
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      finish();
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

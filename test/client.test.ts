import { describe, expect, it, vi } from "vitest";
import { GetARoomClient, GetARoomError } from "../client/index";

const ROOM_ID = "0123456789abcdef0123456789abcdef";

function capability(role: "creator" | "guest" | "observer"): string {
  const payload = Buffer.from(JSON.stringify({ room_id: ROOM_ID, role }), "utf8").toString("base64url");
  return `${payload}.test-signature`;
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("GetARoomClient", () => {
  it("creates a room through the configured service", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({
      room_id: ROOM_ID,
      expires_at: "2030-01-01T00:00:00.000Z",
      creator_capability: capability("creator"),
      lead_invitation_url: "https://rooms.example/join#invite=lead",
      lead_invitation_message: "lead",
      guest_invitation_url: "https://rooms.example/join#invite=guest",
      guest_invitation_message: "guest",
      observer_url: "https://rooms.example/watch#invite=observer",
      observer_message: "observer",
    }, 201));
    const client = new GetARoomClient({ baseUrl: "https://rooms.example", fetch: fetcher });

    const room = await client.createRoom({ task: "Review this", ttlSeconds: 3600 });

    expect(room.room_id).toBe(ROOM_ID);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://rooms.example/v1/rooms");
    expect(typeof init?.body).toBe("string");
    expect(JSON.parse(init?.body as string)).toEqual({ task: "Review this", ttl_seconds: 3600 });
  });

  it("parses only invitations from its configured service", () => {
    const client = new GetARoomClient({ baseUrl: "https://rooms.example", fetch: vi.fn() });
    const guest = capability("guest");

    expect(client.parseInvitation(`Join here: https://rooms.example/join#invite=${guest}`)).toMatchObject({
      baseUrl: "https://rooms.example",
      roomId: ROOM_ID,
      capability: guest,
      role: "guest",
    });
    expect(() => client.parseInvitation(`https://attacker.invalid/join#invite=${guest}`)).toThrow(
      "does not match the configured service",
    );
  });

  it("keeps capabilities out of service error messages", async () => {
    const creator = capability("creator");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(
      { error: "bad_request", message: `Rejected Bearer ${creator}` },
      400,
    ));
    const client = new GetARoomClient({ baseUrl: "https://rooms.example", fetch: fetcher });

    const error = await client.status({ roomId: ROOM_ID, capability: creator }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(GetARoomError);
    expect(String(error)).not.toContain(creator);
    expect(String(error)).toContain("[REDACTED]");
  });

  it("allows plaintext only for loopback development", () => {
    expect(() => new GetARoomClient({ baseUrl: "http://rooms.example", fetch: vi.fn() })).toThrow("must use HTTPS");
    expect(new GetARoomClient({ baseUrl: "http://127.0.0.1:8787", fetch: vi.fn() }).baseUrl).toBe(
      "http://127.0.0.1:8787",
    );
  });
});

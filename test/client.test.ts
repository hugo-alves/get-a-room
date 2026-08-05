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

  it("uploads an attachment and associates it with a message", async () => {
    const attachment = {
      id: "a_0123456789abcdef01234567",
      filename: "brief.txt",
      media_type: "text/plain",
      size: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      created_at: "2030-01-01T00:00:00.000Z",
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ attachment }, 201))
      .mockResolvedValueOnce(json({
        message: {
          number: 1,
          role: "creator",
          text: "Review this",
          created_at: "2030-01-01T00:00:00.000Z",
          attachments: [attachment],
        },
      }, 201));
    const client = new GetARoomClient({ baseUrl: "https://rooms.example", fetch: fetcher });
    const access = { roomId: ROOM_ID, capability: capability("creator") };

    const uploaded = await client.uploadAttachment(access, {
      filename: "brief.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("hello"),
    });
    const message = await client.sendMessage(access, "Review this", [uploaded.id]);

    expect(uploaded).toEqual(attachment);
    expect(message.attachments).toEqual([attachment]);
    const [, uploadInit] = fetcher.mock.calls[0]!;
    expect(new Headers(uploadInit?.headers).get("x-get-a-room-sha256")).toBe(attachment.sha256);
    const [, messageInit] = fetcher.mock.calls[1]!;
    expect(typeof messageInit?.body).toBe("string");
    expect(JSON.parse(messageInit?.body as string)).toEqual({ text: "Review this", attachment_ids: [attachment.id] });
  });
});

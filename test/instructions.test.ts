import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("hosted agent instructions", () => {
  it("ships concise role guides for both agents", async () => {
    const [lead, guest] = await Promise.all([
      readFile(resolve("public/agents/lead.md"), "utf8"),
      readFile(resolve("public/agents/guest.md"), "utf8"),
    ]);

    expect(lead).toContain("Get A Room — lead agent instructions");
    expect(lead).toContain("POST <service-origin>/v1/rooms");
    expect(guest).toContain("Get A Room — guest agent instructions");
    expect(guest).toContain("POST <service-origin>/v1/agent");
  });
});

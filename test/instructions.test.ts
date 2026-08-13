import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("hosted agent instructions", () => {
  it("keeps concise compatibility paths for previously issued invitations", async () => {
    const [lead, guest] = await Promise.all([
      readFile(resolve("public/agents/lead.md"), "utf8"),
      readFile(resolve("public/agents/guest.md"), "utf8"),
    ]);

    expect(lead).toContain("Get A Room — lead instructions compatibility path");
    expect(lead).toContain("/agent#lead");
    expect(lead).toContain("previously issued invitations");
    expect(guest).toContain("Get A Room — guest instructions compatibility path");
    expect(guest).toContain("/agent#guest");
    expect(guest).toContain("previously issued invitations");
  });
});

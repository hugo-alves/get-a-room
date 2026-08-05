import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                ROOM_SIGNING_SECRET: "test-signing-secret-at-least-32-bytes-long", // gitleaks:allow
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/room.test.ts"],
        },
      },
      {
        test: {
          name: "cli",
          environment: "node",
          include: ["test/cli.test.ts", "test/get-a-room.test.ts", "test/client.test.ts"],
        },
      },
    ],
  },
});

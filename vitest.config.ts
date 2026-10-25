import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NATS_SERVERS: process.env.NATS_SERVERS ?? "nats://nats.next-nats.orb.local:4222",
    },
    alias: { "server-only": new URL("./packages/next-nats/test/server-only.ts", import.meta.url).pathname },
  },
});

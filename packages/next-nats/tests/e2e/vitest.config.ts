import { defineConfig } from "vitest/config";

const composeProject = process.env.NEXT_NATS_COMPOSE_PROJECT ?? "next-nats";

export default defineConfig({
  test: {
    include: ["packages/next-nats/tests/e2e/**/*.test.ts"],
    globalSetup: ["packages/next-nats/tests/e2e/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    env: {
      NEXT_NATS_COMPOSE_PROJECT: composeProject,
      NATS_SERVERS: process.env.NATS_SERVERS ?? `nats://nats.${composeProject}.orb.local:4222`,
    },
    alias: { "server-only": new URL("../vitest/server-only.ts", import.meta.url).pathname },
  },
});

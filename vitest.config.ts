import { defineConfig } from "vitest/config";

const shared = {
  testTimeout: 30_000,
  hookTimeout: 30_000,
  env: {
    NATS_SERVERS: process.env.NATS_SERVERS ?? "nats://nats.next-nats.orb.local:4222",
  },
  alias: { "server-only": new URL("./packages/next-nats/tests/vitest/server-only.ts", import.meta.url).pathname },
};

const sharedRedis = "packages/*/tests/vitest/differential/{redis,kv,ratelimit}*.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "default",
          include: ["packages/*/tests/vitest/**/*.test.ts"],
          exclude: [sharedRedis, "**/node_modules/**"],
        },
      },
      {
        test: {
          ...shared,
          name: "shared-redis",
          include: [sharedRedis],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});

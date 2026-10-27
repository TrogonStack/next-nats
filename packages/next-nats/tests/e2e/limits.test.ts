import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upload } from "@trogonstack/next-nats/blob/client";
import { configureBlob } from "@trogonstack/next-nats/blob";
import { stripTags, submitForm, testId } from "./support/html.js";
import { isolatedEnv, unique } from "./support/isolation.js";
import { LIMITED_MAX_STREAMS, limitedEnv, startLimitedNats, type LimitedNats } from "./support/limited.js";
import { openSse } from "./support/sse.js";
import { startServer, waitUntil, type RunningServer } from "./support/server.js";

const PORT = 3851;
const STARTUP_STREAMS = ["CRON"];

const text = async (server: RunningServer, path: string) => (await fetch(`${server.origin}${path}`)).text();

describe("a NATS account capped like Synadia Cloud", () => {
  const env = isolatedEnv("limits");
  let nats: LimitedNats;
  let server: RunningServer;

  const boot = async () => {
    await nats.reset();
    server = await startServer({ variant: "turbopack", port: PORT, env: { ...env, ...limitedEnv() } });
    await waitUntil(async () => (await nats.streams()).includes("CRON"), 30_000, "the cron stream", 250);
  };

  beforeAll(async () => {
    nats = await startLimitedNats();
  });

  beforeEach(boot);

  afterEach(async () => {
    await server?.stop();
  });

  afterAll(async () => {
    await nats?.stop();
  });

  const alone = async (use: () => Promise<void>) => {
    await use();
    const streams = await nats.streams();
    expect(streams.length).toBeLessThanOrEqual(LIMITED_MAX_STREAMS);
  };

  it("starts with far fewer streams than the cap and no consumers beyond the cron ones", async () => {
    const streams = await nats.streams();
    expect(streams).toEqual(STARTUP_STREAMS);
    expect(await nats.consumers()).toBeLessThanOrEqual(2);
  });

  it("provisions the key value store", () =>
    alone(async () => {
      const key = unique("limits:key");
      await submitForm({ origin: server.origin, path: "/kv", button: "SET", values: { key, value: "1" } });
      expect(stripTags(await text(server, "/kv"))).toContain(`${key} (string`);
    }));

  it("provisions edge config", () =>
    alone(async () => {
      const key = unique("limits-flag");
      await submitForm({ origin: server.origin, path: "/edge-config", button: "Upsert", values: { key, value: '{"a":1}' } });
      expect(await text(server, "/edge-config")).toContain(`&quot;${key}&quot;`);
    }));

  it("provisions blob storage", () =>
    alone(async () => {
      configureBlob({ baseUrl: `${server.origin}/blob` });
      const result = await upload(`limits/${unique("file")}.txt`, "capped", { access: "public", handleUploadUrl: `${server.origin}/api/blob/upload` });
      expect((await fetch(result.url)).status).toBe(200);
    }));

  it("provisions the queue and delivers", () =>
    alone(async () => {
      const job = unique("job");
      await submitForm({ origin: server.origin, path: "/queue", button: "Enqueue", values: { text: job } });
      await waitUntil(
        async () => ((await (await fetch(`${server.origin}/queue/log`)).json()) as Array<{ text: string }>).some((line) => line.text === job),
        30_000,
        `queue log to contain ${job}`,
        250,
      );
    }));

  it("provisions rate limiting", () =>
    alone(async () => {
      const response = await fetch(`${server.origin}/api/ratelimit`, { headers: { "x-forwarded-for": unique("client") } });
      expect(response.status).toBe(200);
    }));

  it("provisions both cache handlers together", () =>
    alone(async () => {
      expect(testId(await text(server, "/cache"), "nonce")).toBeTruthy();
      expect(testId(await text(server, "/cache/isr"), "isr-nonce")).toBeTruthy();
      await submitForm({ origin: server.origin, path: "/cache", button: "updateTag" });
    }));

  it("delivers a published message over SSE", () =>
    alone(async () => {
      const sse = await openSse(`${server.origin}/api/realtime/feed`);
      try {
        const message = unique("hello");
        await submitForm({ origin: server.origin, path: "/realtime", button: "Publish", values: { text: message } });
        await sse.waitFor(message);
      } finally {
        sse.close();
      }
    }));

  it("delivers core subject messages to SSE subscribers", () =>
    alone(async () => {
      const sse = await openSse(`${server.origin}/api/realtime/cursors`);
      try {
        const id = unique("cursor");
        const response = await fetch(`${server.origin}/api/realtime/cursors`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, x: 1, y: 2 }),
        });
        expect(response.status).toBe(204);
        await sse.waitFor(id);
      } finally {
        sse.close();
      }
    }));

  it("answers the feed with a clear error when the account has no stream left", async () => {
    await nats.fill(LIMITED_MAX_STREAMS - (await nats.streams()).length);
    const response = await fetch(`${server.origin}/api/realtime/feed`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "UNAVAILABLE", reason: "FEED_STREAM_UNAVAILABLE" });
  });

  it("keeps serving core subject streams when the account has no stream left", async () => {
    await nats.fill(LIMITED_MAX_STREAMS - (await nats.streams()).length);
    const sse = await openSse(`${server.origin}/api/realtime/cursors`);
    try {
      const id = unique("cursor");
      await fetch(`${server.origin}/api/realtime/cursors`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, x: 1, y: 2 }) });
      await sse.waitFor(id);
    } finally {
      sse.close();
    }
  });

  it("fails a stream fast with a clear error once the connection has no subscription left", async () => {
    const controllers: AbortController[] = [];
    const answers: Array<{ status: number; body: unknown }> = [];
    try {
      for (let index = 0; index < 40; index++) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await fetch(`${server.origin}/api/realtime/cursors`, { signal: controller.signal });
        answers.push({ status: response.status, body: response.status === 200 ? undefined : await response.json() });
        if (response.status !== 200) break;
      }
    } finally {
      for (const controller of controllers) controller.abort();
    }
    const rejected = answers.at(-1)!;
    expect(rejected.status).toBe(503);
    expect(rejected.body).toMatchObject({ code: "UNAVAILABLE", reason: "SUBSCRIPTION_REJECTED" });
    expect(answers.length).toBeGreaterThan(1);
  });

  it("fails the stream feed fast once the connection has no subscription left", async () => {
    const controllers: AbortController[] = [];
    try {
      for (let index = 0; index < 40; index++) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await fetch(`${server.origin}/api/realtime/cursors`, { signal: controller.signal });
        if (response.status !== 200) break;
      }
      const response = await fetch(`${server.origin}/api/realtime/feed`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "UNAVAILABLE", reason: "SUBSCRIPTION_REJECTED" });
    } finally {
      for (const controller of controllers) controller.abort();
    }
  });

  it("fails a service start with a clear error when the connection cannot hold its subscriptions", async () => {
    const limited = limitedEnv();
    Object.assign(process.env, limited);
    const { closeNats } = await import("@trogonstack/next-nats");
    const { defineService, endpoint } = await import("@trogonstack/next-nats/services");
    try {
      const service = defineService({
        name: unique("crowded"),
        version: "1.0.0",
        instances: 8,
        endpoints: { ping: endpoint({ handler: () => ({ ok: true }) }) },
      });
      await expect(service.start()).rejects.toMatchObject({ spec: { code: 14, reason: "SUBSCRIPTION_REJECTED" } });
      expect(service.running).toBe(false);
    } finally {
      await closeNats();
      for (const key of Object.keys(limited)) delete process.env[key];
    }
  });

  it("answers service calls", () =>
    alone(async () => {
      const response = await fetch(`${server.origin}/api/services/calc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "add", a: 2, b: 3 }),
      });
      expect(response.status).toBe(200);
    }));
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upload } from "@trogonstack/next-nats/blob/client";
import { configureBlob } from "@trogonstack/next-nats/blob";
import { SELF_HOSTED_VARIANTS, type SelfHostedVariant } from "./support/env.js";
import { startCronCapture, type CronCapture } from "./support/cron-capture.js";
import { stripTags, submitForm, testId } from "./support/html.js";
import { isolatedEnv, unique } from "./support/isolation.js";
import { openSse } from "./support/sse.js";
import { startServer, waitUntil, type RunningServer } from "./support/server.js";

const PORTS: Record<SelfHostedVariant, { app: number; cron: number }> = {
  turbopack: { app: 3841, cron: 3843 },
  webpack: { app: 3842, cron: 3844 },
};

const PAGES = [
  { path: "/", heading: "next-nats" },
  { path: "/kv", heading: "KV" },
  { path: "/blob", heading: "Blob" },
  { path: "/queue", heading: "Queue" },
  { path: "/edge-config", heading: "Edge Config" },
  { path: "/cache", heading: "Cache" },
  { path: "/cache/isr", heading: "Cache ISR" },
  { path: "/ratelimit", heading: "Rate limit" },
  { path: "/realtime", heading: "Realtime" },
  { path: "/services", heading: "Services" },
  { path: "/cron", heading: "Cron" },
];

const text = async (server: RunningServer, path: string) => (await fetch(`${server.origin}${path}`)).text();

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, what: string, timeoutMs = 15_000): Promise<T> {
  let last!: T;
  await waitUntil(async () => accept((last = await read())), timeoutMs, what, 150);
  return last;
}

describe.each(SELF_HOSTED_VARIANTS)("%s next start", (variant) => {
  const env = isolatedEnv(`rt_${variant}`);
  let server: RunningServer;
  let cron: CronCapture;
  let firstCronCall: Promise<void>;

  beforeAll(async () => {
    const ports = PORTS[variant];
    cron = await startCronCapture(ports.cron, (path) => `http://127.0.0.1:${ports.app}${path}`);
    firstCronCall = waitUntil(() => cron.calls.length > 0, 100_000, "the vercel.json cron to fire", 250);
    firstCronCall.catch(() => undefined);
    server = await startServer({ variant, port: ports.app, env: { ...env, NEXT_NATS_CRON_BASE_URL: cron.baseUrl } });
  });

  afterAll(async () => {
    await server?.stop();
    await cron?.stop();
  });

  describe("pages and routes", () => {
    it.each(PAGES)("serves $path", async ({ path, heading }) => {
      const response = await fetch(`${server.origin}${path}`);
      expect(response.status).toBe(200);
      expect(stripTags((await response.text()).replace(/^[\s\S]*?<h1[^>]*>/, "<h1>").replace(/<\/h1>[\s\S]*/, ""))).toBe(heading);
    });

    it("answers 404 for unknown paths", async () => {
      expect((await fetch(`${server.origin}/does/not/exist`)).status).toBe(404);
    });

    it("exposes readiness and liveness", async () => {
      const readiness = await fetch(`${server.origin}/-/readiness`);
      expect([readiness.status, await readiness.text()]).toEqual([200, "ok"]);
      const liveness = await fetch(`${server.origin}/-/liveness`);
      expect([liveness.status, await liveness.text()]).toEqual([200, "ok"]);
      expect(await (await fetch(`${server.origin}/-/readiness?verbose`)).text()).toBe("shutdown: pass\nconnection: pass");
    });

    it("serves JSON from the queue log and cron runs routes", async () => {
      expect(Array.isArray(await (await fetch(`${server.origin}/queue/log`)).json())).toBe(true);
      expect(Array.isArray(await (await fetch(`${server.origin}/cron/runs`)).json())).toBe(true);
    });
  });

  describe("kv and redis", () => {
    it("sets, reads, increments, hashes and deletes through server actions", async () => {
      const key = unique("e2e:key");
      await submitForm({ origin: server.origin, path: "/kv", button: "SET", values: { key, value: '{"a":1}' } });
      let page = await text(server, "/kv");
      expect(page).toContain(`<code>${key}</code>`);
      expect(stripTags(page)).toContain(`${key} (string, ttl -1): {"a":1}`);

      await submitForm({ origin: server.origin, path: "/kv", button: "INCRBY", values: { by: "5" } });
      await submitForm({ origin: server.origin, path: "/kv", button: "INCRBY", values: { by: "2" } });
      expect(stripTags(await text(server, "/kv"))).toContain("demo:counter (string, ttl -1): 7");

      await submitForm({ origin: server.origin, path: "/kv", button: "HSET", values: { field: "name", value: "ada" } });
      expect(stripTags(await text(server, "/kv"))).toContain('demo:profile (hash, ttl -1): {"name":"ada"}');

      const nx = unique("e2e:nx");
      await submitForm({ origin: server.origin, path: "/kv", button: "SET", values: { key: nx, value: "first", ex: "60", nx: "on" } });
      await submitForm({ origin: server.origin, path: "/kv", button: "SET", values: { key: nx, value: "second", nx: "on" } });
      const nxPage = stripTags(await text(server, "/kv"));
      expect(nxPage).toMatch(new RegExp(`${nx} \\(string, ttl (\\d+)\\): "first"`));

      await submitForm({ origin: server.origin, path: "/kv", button: "DEL", values: { key } });
      expect(await text(server, "/kv")).not.toContain(`<code>${key}</code>`);
    });
  });

  describe("ratelimit", () => {
    it("answers 429 with rate limit headers after the limit on the route handler", async () => {
      const identifier = unique("client");
      const responses: Response[] = [];
      for (let attempt = 0; attempt < 7; attempt++) {
        responses.push(await fetch(`${server.origin}/api/ratelimit`, { headers: { "x-forwarded-for": identifier } }));
      }
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 429, 429]);
      expect(responses.slice(0, 5).map((response) => response.headers.get("x-ratelimit-remaining"))).toEqual(["4", "3", "2", "1", "0"]);
      expect(responses[5]!.headers.get("x-ratelimit-limit")).toBe("5");
      expect(Number(responses[5]!.headers.get("x-ratelimit-reset"))).toBeGreaterThan(Date.now());
      expect(await responses[5]!.json()).toMatchObject({ code: "RESOURCE_EXHAUSTED", reason: "RATE_LIMITED" });
      const other = await fetch(`${server.origin}/api/ratelimit`, { headers: { "x-forwarded-for": unique("client") } });
      expect(other.status).toBe(200);
    });

    it.each(["sliding", "fixed", "bucket"])("blocks the sixth hit through the %s server action", async (algo) => {
      const identifier = unique(algo);
      const lines: string[] = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        const html = await submitForm({ origin: server.origin, path: "/ratelimit", button: "Hit it", values: { algo, identifier } });
        lines.push(stripTags(html.match(/<pre>([\s\S]*?)<\/pre>/)?.[1] ?? ""));
      }
      expect(lines[4]).toContain(`${algo} ${identifier}: allowed`);
      expect(lines[5]).toContain(`${algo} ${identifier}: BLOCKED`);
    });
  });

  describe("blob", () => {
    it("uploads through the client token flow and downloads through the blob route", async () => {
      configureBlob({ baseUrl: `${server.origin}/blob` });
      const payload = new Uint8Array(4096).map((_, index) => index % 251);
      const result = await upload(`e2e/${unique("file")}.bin`, new Blob([payload], { type: "application/octet-stream" }), {
        access: "public",
        handleUploadUrl: `${server.origin}/api/blob/upload`,
      });
      expect(result.url.startsWith(`${server.origin}/blob/e2e/`)).toBe(true);
      expect(result.pathname).toMatch(/^e2e\/file-[a-z0-9]+-[A-Za-z0-9]+\.bin$/);

      const download = await fetch(result.url);
      expect(download.status).toBe(200);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(payload);
      expect(download.headers.get("content-type")).toBe("application/octet-stream");

      const attachment = await fetch(`${result.url}?download=1`);
      expect(attachment.headers.get("content-disposition")).toMatch(/^attachment/);

      const range = await fetch(result.url, { headers: { range: "bytes=10-19" } });
      expect(range.status).toBe(206);
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(payload.slice(10, 20));

      expect((await fetch(result.url, { method: "HEAD" })).headers.get("content-length")).toBe("4096");
      await waitUntil(() => server.logs().includes(`blob upload completed ${result.pathname}`), 10_000, "the upload completed callback");

      expect(stripTags(await text(server, "/blob"))).toContain(result.pathname);
      await submitForm({ origin: server.origin, path: "/blob", button: "delete" });
    });

    it("rejects a PUT without a token and a download of a missing blob", async () => {
      expect((await fetch(`${server.origin}/blob/e2e/anonymous.txt`, { method: "PUT", body: "nope" })).status).toBeGreaterThanOrEqual(400);
      expect((await fetch(`${server.origin}/blob/e2e/missing.txt`)).status).toBe(404);
    });

    it("deletes a blob through the server action", async () => {
      configureBlob({ baseUrl: `${server.origin}/blob` });
      const result = await upload(`e2e/${unique("gone")}.txt`, "short lived", { access: "public", handleUploadUrl: `${server.origin}/api/blob/upload` });
      expect((await fetch(result.url)).status).toBe(200);
      const page = await text(server, "/blob");
      expect(page).toContain(result.pathname);
      await submitForm({ origin: server.origin, path: "/blob", button: "delete", values: { pathname: result.pathname } });
      expect((await fetch(result.url)).status).toBe(404);
    });
  });

  describe("edge config", () => {
    it("reads a value after writing it and stops reading it after the delete", async () => {
      const key = unique("e2e-flag");
      await submitForm({ origin: server.origin, path: "/edge-config", button: "Upsert", values: { key, value: '{"banner":"hi"}' } });
      const written = await text(server, "/edge-config");
      expect(written).toContain(`&quot;${key}&quot;: {`);
      expect(stripTags(written)).toContain('"banner": "hi"');
      await submitForm({ origin: server.origin, path: "/edge-config", button: "Delete", values: { key } });
      expect(await text(server, "/edge-config")).not.toContain(`&quot;${key}&quot;`);
    });
  });

  describe("queue", () => {
    it("delivers a sent message to the triggered route handler", async () => {
      const job = unique("job");
      await submitForm({ origin: server.origin, path: "/queue", button: "Enqueue", values: { text: job } });
      const log = await eventually(
        async () => (await (await fetch(`${server.origin}/queue/log`)).json()) as Array<{ text: string; outcome: string; deliveryCount: number }>,
        (lines) => lines.some((line) => line.text === job),
        `queue log to contain ${job}`,
      );
      expect(log.filter((line) => line.text === job)).toEqual([expect.objectContaining({ outcome: "processed", deliveryCount: 1 })]);
    });

    it("honours the delay", async () => {
      const job = unique("delayed");
      const sentAt = Date.now();
      await submitForm({ origin: server.origin, path: "/queue", button: "Enqueue", values: { text: job, delay: "3" } });
      await eventually(
        async () => (await (await fetch(`${server.origin}/queue/log`)).json()) as Array<{ text: string }>,
        (lines) => lines.some((line) => line.text === job),
        `delayed ${job}`,
      );
      expect(Date.now() - sentAt).toBeGreaterThanOrEqual(2_500);
    });

    it("redelivers after the handler throws and counts the deliveries", async () => {
      const job = unique("flaky");
      await submitForm({ origin: server.origin, path: "/queue", button: "Enqueue", values: { text: job, fail: "on" } });
      const log = await eventually(
        async () => (await (await fetch(`${server.origin}/queue/log`)).json()) as Array<{ text: string; outcome: string; deliveryCount: number }>,
        (lines) => lines.some((line) => line.text === job && line.outcome === "processed"),
        `flaky ${job} to succeed`,
        30_000,
      );
      const attempts = log.filter((line) => line.text === job).map((line) => `${line.deliveryCount}:${line.outcome}`).sort();
      expect(attempts).toEqual(["1:failed", "2:failed", "3:processed"]);
    });
  });

  describe("realtime", () => {
    it("delivers a published message over SSE", async () => {
      const sse = await openSse(`${server.origin}/api/realtime/feed`);
      try {
        const message = unique("hello");
        await submitForm({ origin: server.origin, path: "/realtime", button: "Publish", values: { text: message } });
        await sse.waitFor(message);
        expect(sse.text()).toMatch(new RegExp(`id: \\d+\\n[^\\n]*data: \\{[^\\n]*${message}`));
      } finally {
        sse.close();
      }
    });

    it("delivers core subject messages to SSE subscribers", async () => {
      const sse = await openSse(`${server.origin}/api/realtime/cursors`);
      try {
        const id = unique("cursor");
        await new Promise((resolve) => setTimeout(resolve, 300));
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
    });
  });

  describe("services", () => {
    it("answers request and reply calls", async () => {
      const response = await fetch(`${server.origin}/api/services/calc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "add", a: 2, b: 3 }),
      });
      expect([response.status, await response.json()]).toEqual([200, expect.objectContaining({ result: 5 })]);
    });
  });

  describe("cache", () => {
    it("serves one use cache entry until updateTag expires it", async () => {
      const first = testId(await text(server, "/cache"), "nonce");
      expect(first).toBeTruthy();
      expect(testId(await text(server, "/cache"), "nonce")).toBe(first);
      await submitForm({ origin: server.origin, path: "/cache", button: "updateTag" });
      const second = await eventually(async () => testId(await text(server, "/cache"), "nonce"), (nonce) => nonce !== first, "a fresh use cache entry");
      expect(second).not.toBe(first);
      expect(testId(await text(server, "/cache"), "nonce")).toBe(second);
    });

    it("serves stale content then a fresh entry after revalidateTag", async () => {
      const first = testId(await text(server, "/cache"), "nonce");
      await submitForm({ origin: server.origin, path: "/cache", button: "revalidateTag" });
      const refreshed = await eventually(async () => testId(await text(server, "/cache"), "nonce"), (nonce) => nonce !== first, "background revalidation");
      expect(refreshed).not.toBe(first);
    });

    it("serves one fetch cache entry until updateTag expires it", async () => {
      const first = testId(await text(server, "/cache/isr"), "isr-nonce");
      expect(first).toBeTruthy();
      expect(testId(await text(server, "/cache/isr"), "isr-nonce")).toBe(first);
      await submitForm({ origin: server.origin, path: "/cache/isr", button: "updateTag demo-isr" });
      const second = await eventually(async () => testId(await text(server, "/cache/isr"), "isr-nonce"), (nonce) => nonce !== first, "a fresh fetch cache entry");
      expect(second).not.toBe(first);
    });
  });

  describe("cron", () => {
    it("rejects the cron route without the secret", async () => {
      expect((await fetch(`${server.origin}/api/cron/heartbeat`)).status).toBe(401);
    });

    it("fires the vercel.json route with the Vercel cron headers", async () => {
      await firstCronCall;
      const call = cron.calls[0]!;
      expect(call.path).toBe("/api/cron/heartbeat");
      expect(call.headers["user-agent"]).toBe("vercel-cron/1.0");
      expect(call.headers["x-vercel-cron-schedule"]).toBe("* * * * *");
      expect(call.headers.authorization).toBe(`Bearer ${env.CRON_SECRET}`);
      expect(call.forwardedStatus).toBe(200);
    });

    it("runs a cron on demand and records it", async () => {
      const triggered = await fetch(`${server.origin}/cron/runs`, { method: "POST" });
      expect(triggered.status).toBe(200);
      expect(await triggered.json()).toEqual(expect.objectContaining({ duplicate: expect.any(Boolean) }));
    });
  });
});

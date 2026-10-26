import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upload } from "@trogonstack/next-nats/blob/client";
import { configureBlob, issueSignedToken, presignUrl } from "@trogonstack/next-nats/blob";
import { startCronCapture, type CronCapture } from "./support/cron-capture.js";
import { stripTags, submitForm, testId } from "./support/html.js";
import { isolatedEnv, unique } from "./support/isolation.js";
import { openSse } from "./support/sse.js";
import { SHARED_ENV, startServer, waitUntil, type RunningServer } from "./support/server.js";

const PORTS = { a: 3845, b: 3846, cron: 3847 } as const;
const MINUTE_MS = 60_000;

const text = async (server: RunningServer, path: string) => (await fetch(`${server.origin}${path}`)).text();

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, what: string, timeoutMs = 15_000): Promise<T> {
  let last!: T;
  await waitUntil(async () => accept((last = await read())), timeoutMs, what, 100);
  return last;
}

interface QueueLine {
  text: string;
  deliveryCount: number;
  outcome: string;
}

describe("two replicas on one NATS", () => {
  const env = isolatedEnv("replicas");
  let a: RunningServer;
  let b: RunningServer;
  let cron: CronCapture;
  let tickAt: number;

  beforeAll(async () => {
    cron = await startCronCapture(PORTS.cron, (path) => `http://127.0.0.1:${PORTS.a}${path}`);
    const shared = { ...env, NEXT_NATS_CRON_BASE_URL: cron.baseUrl, CLOCK_ORIGIN: `http://127.0.0.1:${PORTS.a}` };
    const now = Date.now();
    tickAt = Math.ceil(now / MINUTE_MS) * MINUTE_MS;
    if (tickAt - now < 45_000) tickAt += MINUTE_MS;
    [a, b] = await Promise.all([
      startServer({ variant: "turbopack", port: PORTS.a, env: shared }),
      startServer({ variant: "turbopack", port: PORTS.b, env: shared }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()]);
    await cron?.stop();
  });

  it("shares a use cache entry and propagates updateTag in both directions", async () => {
    const first = testId(await text(a, "/cache"), "nonce");
    expect(first).toBeTruthy();
    expect(testId(await text(b, "/cache"), "nonce")).toBe(first);

    await submitForm({ origin: a.origin, path: "/cache", button: "updateTag" });
    const onB = await eventually(async () => testId(await text(b, "/cache"), "nonce"), (nonce) => nonce !== first, "B to see the tag expire");
    expect(testId(await text(a, "/cache"), "nonce")).toBe(onB);

    await submitForm({ origin: b.origin, path: "/cache", button: "updateTag" });
    const onA = await eventually(async () => testId(await text(a, "/cache"), "nonce"), (nonce) => nonce !== onB, "A to see the tag expire");
    expect(testId(await text(b, "/cache"), "nonce")).toBe(onA);
  });

  it("shares a fetch cache entry and propagates updateTag", async () => {
    const first = testId(await text(a, "/cache/isr"), "isr-nonce");
    expect(first).toBeTruthy();
    expect(testId(await text(b, "/cache/isr"), "isr-nonce")).toBe(first);
    await submitForm({ origin: b.origin, path: "/cache/isr", button: "updateTag demo-isr" });
    const onA = await eventually(async () => testId(await text(a, "/cache/isr"), "isr-nonce"), (nonce) => nonce !== first, "A to see the fetch tag expire");
    expect(testId(await text(b, "/cache/isr"), "isr-nonce")).toBe(onA);
  });

  it("shares ratelimit counts", async () => {
    const identifier = unique("shared-client");
    const statuses: number[] = [];
    for (const replica of [a, b, a, b, a, b, a]) {
      statuses.push((await fetch(`${replica.origin}/api/ratelimit`, { headers: { "x-forwarded-for": identifier } })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });

  it("shares KV and edge config writes", async () => {
    const key = unique("e2e:shared");
    await submitForm({ origin: a.origin, path: "/kv", button: "SET", values: { key, value: "from-a" } });
    expect(stripTags(await text(b, "/kv"))).toContain(`${key} (string, ttl -1): "from-a"`);

    const flag = unique("e2e-flag");
    await submitForm({ origin: a.origin, path: "/edge-config", button: "Upsert", values: { key: flag, value: '"on"' } });
    await eventually(async () => text(b, "/edge-config"), (page) => page.includes(`&quot;${flag}&quot;`), "B to mirror the edge config write");
  });

  it("accepts a client token issued by one replica on the other and serves the blob from both", async () => {
    const payload = new TextEncoder().encode(`signed-by-a ${unique("body")}`);
    configureBlob({ baseUrl: `${b.origin}/blob`, secret: SHARED_ENV.BLOB_SECRET });
    const result = await upload(`e2e/${unique("cross")}.txt`, new Blob([payload], { type: "text/plain" }), {
      access: "public",
      handleUploadUrl: `${a.origin}/api/blob/upload`,
    });
    expect(result.url.startsWith(`${b.origin}/blob/`)).toBe(true);
    for (const replica of [a, b]) {
      const response = await fetch(`${replica.origin}/blob/${result.pathname}`);
      expect([replica.port, response.status]).toEqual([replica.port, 200]);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
    }
    await waitUntil(() => a.logs().includes(`blob upload completed ${result.pathname}`) || b.logs().includes(`blob upload completed ${result.pathname}`), 10_000, "the upload completed callback");
  });

  it("verifies presigned URLs on every replica and rejects forged ones", async () => {
    const pathname = `e2e/${unique("private")}.txt`;
    const body = unique("private-body");
    configureBlob({ baseUrl: `${a.origin}/blob`, secret: SHARED_ENV.BLOB_SECRET });
    const token = await issueSignedToken({ pathname, operations: ["put", "get"] });
    const put = await presignUrl(token, { operation: "put", pathname, access: "private", addRandomSuffix: false });
    const get = await presignUrl(token, { operation: "get", pathname, access: "private" });
    const onReplica = (presigned: string, replica: RunningServer) => {
      const url = new URL(presigned);
      return `${replica.origin}${url.pathname}${url.search}`;
    };

    const stored = await fetch(onReplica(put.presignedUrl, b), { method: "PUT", headers: { "x-blob-access": "private", "content-type": "text/plain" }, body });
    expect(stored.status).toBe(200);

    expect((await fetch(`${a.origin}/blob/${pathname}`)).status).toBe(403);
    expect((await fetch(`${b.origin}/blob/${pathname}`)).status).toBe(403);
    for (const replica of [a, b]) {
      const response = await fetch(onReplica(get.presignedUrl, replica));
      expect([replica.port, response.status, await response.text()]).toEqual([replica.port, 200, body]);
    }

    const tampered = new URL(get.presignedUrl);
    tampered.searchParams.set("signature", `${tampered.searchParams.get("signature")}x`);
    for (const replica of [a, b]) {
      expect((await fetch(onReplica(tampered.toString(), replica))).status).toBeGreaterThanOrEqual(400);
    }
  });

  it("rejects tokens signed with a different secret on every replica", async () => {
    const pathname = `e2e/${unique("forged")}.txt`;
    configureBlob({ baseUrl: `${a.origin}/blob`, secret: "some-other-secret" });
    const token = await issueSignedToken({ pathname, operations: ["put"] });
    const put = await presignUrl(token, { operation: "put", pathname, access: "public", addRandomSuffix: false });
    const url = new URL(put.presignedUrl);
    for (const replica of [a, b]) {
      const response = await fetch(`${replica.origin}${url.pathname}${url.search}`, { method: "PUT", body: "forged" });
      expect([replica.port, response.status >= 400]).toEqual([replica.port, true]);
    }
    expect((await fetch(`${a.origin}/blob/${pathname}`)).status).toBe(404);
  });

  it("delivers a queue message to exactly one replica", async () => {
    const job = unique("shared-job");
    await submitForm({ origin: a.origin, path: "/queue", button: "Enqueue", values: { text: job } });
    const read = async () => (await (await fetch(`${b.origin}/queue/log`)).json()) as QueueLine[];
    await eventually(read, (lines) => lines.some((line) => line.text === job), `${job} to be processed`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect((await read()).filter((line) => line.text === job)).toEqual([expect.objectContaining({ deliveryCount: 1, outcome: "processed" })]);
  });

  it("streams a message published on one replica to an SSE client on the other", async () => {
    const sse = await openSse(`${b.origin}/api/realtime/feed`);
    try {
      const message = unique("cross-replica");
      await submitForm({ origin: a.origin, path: "/realtime", button: "Publish", values: { text: message } });
      await sse.waitFor(message);
    } finally {
      sse.close();
    }
  });

  it("fires a cron schedule exactly once across both replicas", async () => {
    await waitUntil(() => Date.now() > tickAt + 8_000, 120_000, "the cron tick and its grace period", 500);
    const fired = cron.calls.filter((call) => call.receivedAt >= tickAt - 1_000 && call.receivedAt < tickAt + MINUTE_MS);
    expect(fired.map((call) => [call.path, call.forwardedStatus, call.headers["x-vercel-cron-schedule"]])).toEqual([["/api/cron/heartbeat", 200, "* * * * *"]]);
  });
});

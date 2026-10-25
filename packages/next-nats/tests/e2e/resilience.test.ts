import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@trogonstack/next-nats/kv";
import { restartNats } from "./support/compose.js";
import { stripTags, submitForm } from "./support/html.js";
import { isolatedEnv, unique } from "./support/isolation.js";
import { runKvWorker } from "./support/kv-workers.js";
import { startServer, waitUntil, type RunningServer } from "./support/server.js";

const PORT = 3850;
const text = async (server: RunningServer, path: string) => (await fetch(`${server.origin}${path}`)).text();
const status = async (url: string) => (await fetch(url).catch(() => undefined))?.status;

interface QueueLine {
  text: string;
  deliveryCount: number;
  outcome: string;
}

describe("NATS restarts while the app keeps running", () => {
  const env = isolatedEnv("resilience");
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer({ variant: "turbopack", port: PORT, env });
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("recovers every capability without restarting the process", async () => {
    const key = unique("e2e:survivor");
    await submitForm({ origin: server.origin, path: "/kv", button: "SET", values: { key, value: "before" } });
    expect(stripTags(await text(server, "/kv"))).toContain(`${key} (string, ttl -1): "before"`);
    const pid = server.pid;

    const errors: string[] = [];
    let flowing = true;
    const traffic = (async () => {
      while (flowing) {
        const response = await fetch(`${server.origin}/api/ratelimit`, { headers: { "x-forwarded-for": unique("flow") } }).catch((error: Error) => error);
        if (response instanceof Error) errors.push(response.message);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();

    await restartNats();
    await waitUntil(async () => (await status(`${server.origin}/-/readiness`)) === 200, 60_000, "readiness to return after the restart", 250);
    flowing = false;
    await traffic;
    expect(errors).toEqual([]);

    await waitUntil(
      async () => {
        const response = await fetch(`${server.origin}/api/ratelimit`, { headers: { "x-forwarded-for": unique("after") } }).catch(() => undefined);
        return response?.status === 200;
      },
      30_000,
      "ratelimit to answer after the restart",
      250,
    );

    await waitUntil(async () => stripTags(await text(server, "/kv")).includes(`${key} (string, ttl -1): "before"`), 30_000, "the key written before the restart to be readable", 250);
    const after = unique("e2e:after");
    await submitForm({ origin: server.origin, path: "/kv", button: "SET", values: { key: after, value: "after" } });
    expect(stripTags(await text(server, "/kv"))).toContain(`${after} (string, ttl -1): "after"`);
    expect(await status(`${server.origin}/-/liveness`)).toBe(200);
    expect(server.pid).toBe(pid);
  });

  it("keeps serving a use cache entry and invalidates it after the restart", async () => {
    const nonceOf = async () => stripTags(await text(server, "/cache")).match(/nonce\s+(\S+)/)?.[1];
    const before = await nonceOf();
    await restartNats();
    await waitUntil(async () => (await status(`${server.origin}/-/readiness`)) === 200, 60_000, "readiness", 250);
    await waitUntil(
      async () => (await submitForm({ origin: server.origin, path: "/cache", button: "updateTag" }).then(() => true, () => false)),
      30_000,
      "updateTag to succeed after the restart",
      500,
    );
    await waitUntil(async () => (await nonceOf()) !== before, 30_000, "a fresh entry after the restart", 250);
  });

  it("redelivers queue messages that were in flight during the restart instead of losing them", async () => {
    const jobs = Array.from({ length: 4 }, () => unique("inflight"));
    for (const job of jobs) await submitForm({ origin: server.origin, path: "/queue", button: "Enqueue", values: { text: job, fail: "on" } });
    await restartNats();
    const read = async () => {
      const response = await fetch(`${server.origin}/queue/log`).catch(() => undefined);
      return response?.ok ? ((await response.json()) as QueueLine[]) : [];
    };
    await waitUntil(
      async () => {
        const lines = await read();
        return jobs.every((job) => lines.some((line) => line.text === job && line.outcome === "processed"));
      },
      90_000,
      "every in-flight job to be processed after the restart",
      500,
    );
    const lines = await read();
    for (const job of jobs) {
      const processed = lines.filter((line) => line.text === job && line.outcome === "processed");
      expect(processed).toHaveLength(1);
    }
  });

  it("accepts and processes new queue messages after the restart", async () => {
    const job = unique("after-restart");
    await restartNats();
    await waitUntil(async () => (await status(`${server.origin}/-/readiness`)) === 200, 60_000, "readiness", 250);
    await waitUntil(
      async () => {
        const html = await submitForm({ origin: server.origin, path: "/queue", button: "Enqueue", values: { text: job } }).catch(() => "");
        return stripTags(html).includes("Enqueued");
      },
      30_000,
      "enqueue to succeed after the restart",
      500,
    );
    await waitUntil(
      async () => (((await (await fetch(`${server.origin}/queue/log`)).json()) as QueueLine[]).some((line) => line.text === job && line.outcome === "processed")),
      30_000,
      `${job} to be processed`,
      250,
    );
  });
});

describe("KV transactions across processes", () => {
  const bucket = `kv_tx_${Date.now().toString(36)}`;
  const kv = () => createClient({});
  const accounts = { source: "tx:source", target: "tx:target" } as const;

  beforeAll(() => {
    process.env.NEXT_NATS_KV_BUCKET = bucket;
  });

  async function balances(): Promise<[number, number]> {
    const client = kv();
    return [Number((await client.get(accounts.source)) ?? 0), Number((await client.get(accounts.target)) ?? 0)];
  }

  it("never loses or duplicates a transfer under contention", async () => {
    const workers = 4;
    const operations = 25;
    const reports = await Promise.all(Array.from({ length: workers }, () => runKvWorker({ bucket, ...accounts, operations })));
    expect(reports.map((report) => report.failed)).toEqual(Array(workers).fill(0));
    expect(await balances()).toEqual([-workers * operations, workers * operations]);
  });

  it("keeps every transfer all-or-nothing while NATS restarts", async () => {
    const before = await balances();
    const workers = 3;
    const operations = 40;
    const running = Promise.all(Array.from({ length: workers }, () => runKvWorker({ bucket, ...accounts, operations })));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await restartNats();
    const reports = await running;
    const acknowledged = reports.reduce((sum, report) => sum + report.acknowledged, 0);
    const failed = reports.reduce((sum, report) => sum + report.failed, 0);
    expect(acknowledged + failed).toBe(workers * operations);

    let after: [number, number] = before;
    await waitUntil(async () => ((after = await balances().catch(() => before)), true), 30_000, "balances to be readable", 250);
    const moved = after[1] - before[1];
    expect(after[0] + after[1]).toBe(before[0] + before[1]);
    expect(moved).toBeGreaterThanOrEqual(acknowledged);
    expect(moved).toBeLessThanOrEqual(acknowledged + failed);
    expect(after[0] - before[0]).toBe(-moved);
  });
});

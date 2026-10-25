import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { createCronRuntime, readVercelCrons, registerVercelCrons, vercelCronName } from "../../src/cron/index.js";

const run = Math.random().toString(36).slice(2, 8);
const stream = `CRONV_${run}`;
const prefix = `cronv${run}`;
const dir = mkdtempSync(join(tmpdir(), "vercel-cron-"));
const config = join(dir, "vercel.json");

interface Hit {
  method?: string;
  url?: string;
  userAgent?: string;
  authorization?: string;
}

const hits: Hit[] = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, workers: true, name: "next-nats-cron-vercel-test" });
  server = createServer((req: IncomingMessage, res) => {
    hits.push({ method: req.method, url: req.url, userAgent: req.headers["user-agent"], authorization: req.headers.authorization });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(config, JSON.stringify({ crons: [{ path: "/api/cron/daily?x=1", schedule: "0 5 * * *" }] }));
});

afterAll(async () => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  const { jsm } = await getNats();
  await jsm.streams.delete(stream).catch(() => undefined);
  await closeNats();
});

describe("vercel.json crons", () => {
  it("reads and validates the crons array", () => {
    expect(readVercelCrons(config)).toEqual([{ path: "/api/cron/daily?x=1", schedule: "0 5 * * *" }]);
    expect(readVercelCrons(join(dir, "missing.json"))).toEqual([]);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ crons: [{ path: "no-slash", schedule: "0 5 * * *" }] }));
    expect(() => readVercelCrons(bad)).toThrow("path");
    writeFileSync(bad, JSON.stringify({ crons: [{ path: "/a", schedule: "* * * * * *" }] }));
    expect(() => readVercelCrons(bad)).toThrow("five field");
  });

  it("names the same path with different schedules apart", () => {
    const a = vercelCronName({ path: "/api/cron/x", schedule: "0 5 * * *" });
    const b = vercelCronName({ path: "/api/cron/x", schedule: "0 6 * * *" });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("calls the route with GET, user agent and bearer exactly once across two schedulers", async () => {
    process.env.CRON_SECRET = "s3cret";
    const a = createCronRuntime({ stream, prefix, replica: "a" });
    const b = createCronRuntime({ stream, prefix, replica: "b" });
    const [jobA] = registerVercelCrons({ configPath: config, baseUrl, runtime: a });
    const [jobB] = registerVercelCrons({ configPath: config, baseUrl, runtime: b });
    const at = new Date(Date.now() - 1_000);
    const results = await Promise.all([jobA!.trigger(at), jobB!.trigger(at)]);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    const end = Date.now() + 15_000;
    while (hits.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(hits).toEqual([
      { method: "GET", url: "/api/cron/daily?x=1", userAgent: "vercel-cron/1.0", authorization: "Bearer s3cret" },
    ]);
    delete process.env.CRON_SECRET;
    await Promise.all([a.stop(), b.stop()]);
  });

  it("omits authorization when CRON_SECRET is unset", async () => {
    hits.length = 0;
    const rt = createCronRuntime({ stream, prefix, replica: "c" });
    const [job] = registerVercelCrons({ configPath: config, baseUrl, runtime: rt });
    await job!.trigger(new Date(Date.now() - 500));
    const end = Date.now() + 15_000;
    while (hits.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(hits[0]).toMatchObject({ method: "GET", userAgent: "vercel-cron/1.0", authorization: undefined });
    await rt.stop();
  });
});

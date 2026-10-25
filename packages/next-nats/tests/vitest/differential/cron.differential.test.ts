import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../../src/connection.js";
import { createCronRuntime, readVercelCrons, registerVercelCrons } from "../../../src/cron/index.js";

const run = Math.random().toString(36).slice(2, 8);
const stream = `CRD_${run}`;
const prefix = `crd${run}`;
const scratch = join(process.cwd(), ".trogonai", "scratch");
const dir = mkdtempSync(join((await import("node:fs")).mkdirSync(scratch, { recursive: true }) ?? scratch, "cron-diff-"));

interface Hit {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
}

const hits: Hit[] = [];
let respond: (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let baseUrl: string;

const configWith = (crons: unknown): string => {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ crons }));
  return file;
};

const waitForHits = async (count: number, timeoutMs = 20_000) => {
  const end = Date.now() + timeoutMs;
  while (hits.length < count && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, workers: true, name: "next-nats-cron-differential" });
  server = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, headers: req.headers });
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  const { jsm } = await getNats();
  await jsm.streams.delete(stream).catch(() => undefined);
  await closeNats();
});

describe("vercel.json crons schema (vercel.com/docs/cron-jobs, /usage-and-pricing)", () => {
  const accepted = ["* * * * *", "5 * * * *", "* 5 * * *", "* * 5 * *", "* * * 5 *", "* * * * 5", "0 5 * * *", "*/5 * * * *", "0 0 1,15 * *", "0 9-17 * * 1-5", "0 0 * * 0", "59 23 * 12 6", "59 23 31 12 *"];
  const rejected: Array<[string, string]> = [
    ["six fields", "* * * * * *"],
    ["four fields", "* * * *"],
    ["empty", ""],
    ["day name", "0 0 * * MON"],
    ["month name", "0 0 1 JAN *"],
    ["day of month and day of week", "0 0 5 * 1"],
    ["minute out of range", "60 * * * *"],
    ["hour out of range", "* 24 * * *"],
    ["day of month zero", "* * 0 * *"],
    ["month thirteen", "* * * 13 *"],
    ["day of week seven", "* * * * 8"],
  ];

  it.each(accepted)("accepts %s", (schedule) => {
    expect(readVercelCrons(configWith([{ path: "/api/cron", schedule }]))).toEqual([{ path: "/api/cron", schedule }]);
  });

  it.each(rejected)("rejects %s", (_label, schedule) => {
    expect(() => readVercelCrons(configWith([{ path: "/api/cron", schedule }]))).toThrow(/schedule/);
  });

  it("requires a path that starts with a slash", () => {
    for (const path of ["api/cron", "", 5, undefined, null]) {
      expect(() => readVercelCrons(configWith([{ path, schedule: "0 5 * * *" }]))).toThrow(/path/);
    }
  });

  it("keeps query strings and allows the same path on several schedules", () => {
    const crons = [
      { path: "/api/sync", schedule: "*/5 * * * *" },
      { path: "/api/sync", schedule: "0 0 * * *" },
      { path: "/api/sync-slack-team/T0CAQ10TZ?full=1", schedule: "0 5 * * *" },
    ];
    expect(readVercelCrons(configWith(crons))).toEqual(crons);
  });

  it("allows up to a hundred cron jobs per project and rejects more", () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/api/${i}`, schedule: "0 5 * * *" }));
    expect(readVercelCrons(configWith(make(100)))).toHaveLength(100);
    expect(() => readVercelCrons(configWith(make(101)))).toThrow(/more than 100/);
  });

  it("returns nothing when crons is absent and rejects a non array", () => {
    expect(readVercelCrons(configWith(undefined))).toEqual([]);
    expect(() => readVercelCrons(configWith({ path: "/a", schedule: "* * * * *" }))).toThrow(/array/);
  });

  it("agrees with the documented grammar on generated expressions", () => {
    const field = (min: number, max: number) =>
      fc.oneof(
        fc.constant("*"),
        fc.integer({ min, max }).map(String),
        fc.integer({ min: 1, max: 9 }).map((n) => `*/${n}`),
        fc.tuple(fc.integer({ min, max }), fc.integer({ min, max })).map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`),
      );
    const expression = fc.tuple(field(0, 59), field(0, 23), field(1, 31), field(1, 12), field(0, 6)).map((f) => f.join(" "));
    fc.assert(
      fc.property(expression, (schedule) => {
        const fields = schedule.split(" ");
        const bothDays = fields[2] !== "*" && fields[4] !== "*";
        const parse = () => readVercelCrons(configWith([{ path: "/p", schedule }]));
        if (bothDays) expect(parse).toThrow(/day of month and day of week/);
        else expect(parse()).toEqual([{ path: "/p", schedule }]);
      }),
      { seed: 20260101, numRuns: 150 },
    );
  });
});

describe("vercel cron invocation (vercel.com/docs/cron-jobs/manage-cron-jobs)", () => {
  const triggerOnce = async (runtime: ReturnType<typeof createCronRuntime>, options: Parameters<typeof registerVercelCrons>[0]) => {
    const [job] = registerVercelCrons({ baseUrl, runtime, ...options });
    await job!.trigger(new Date(Date.now() - 500));
    return job!;
  };

  it("makes a GET with the cron user agent, schedule header and bearer secret", async () => {
    hits.length = 0;
    respond = (_req, res) => res.end("ok");
    const rt = createCronRuntime({ stream, prefix, replica: "shape" });
    await triggerOnce(rt, { configPath: configWith([{ path: "/api/cron?x=1", schedule: "0 5 * * *" }]), secret: "0123456789abcdef" });
    await waitForHits(1);
    await settle(500);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: "GET", url: "/api/cron?x=1" });
    expect(hits[0]!.headers["user-agent"]).toBe("vercel-cron/1.0");
    expect(hits[0]!.headers["x-vercel-cron-schedule"]).toBe("0 5 * * *");
    expect(hits[0]!.headers.authorization).toBe("Bearer 0123456789abcdef");
    await rt.stop();
  });

  it("reads CRON_SECRET from the environment and omits authorization without it", async () => {
    const rt = createCronRuntime({ stream, prefix, replica: "env" });
    const configPath = configWith([{ path: "/api/env", schedule: "0 6 * * *" }]);
    hits.length = 0;
    process.env.CRON_SECRET = "from-env-0123456789";
    await triggerOnce(rt, { configPath });
    await waitForHits(1);
    expect(hits[0]!.headers.authorization).toBe("Bearer from-env-0123456789");
    delete process.env.CRON_SECRET;
    hits.length = 0;
    const [job] = registerVercelCrons({ baseUrl, runtime: rt, configPath });
    await job!.trigger(new Date(Date.now() - 400));
    await waitForHits(1);
    expect(hits[0]!.headers.authorization).toBeUndefined();
    await rt.stop();
  });

  it("does not follow redirects and treats a 3xx as final", async () => {
    hits.length = 0;
    respond = (_req, res) => {
      res.statusCode = 307;
      res.setHeader("location", "/elsewhere");
      res.end();
    };
    const rt = createCronRuntime({ stream, prefix, replica: "redirect" });
    await triggerOnce(rt, { configPath: configWith([{ path: "/api/redirect", schedule: "0 7 * * *" }]) });
    await waitForHits(1);
    await settle(1_500);
    expect(hits.map((h) => h.url)).toEqual(["/api/redirect"]);
    await rt.stop();
  });

  it.each([500, 404])("does not retry a %i response", async (status) => {
    hits.length = 0;
    respond = (_req, res) => {
      res.statusCode = status;
      res.end("fail");
    };
    const rt = createCronRuntime({ stream, prefix, replica: `fail${status}` });
    await triggerOnce(rt, { configPath: configWith([{ path: `/api/fail${status}`, schedule: "0 8 * * *" }]) });
    await waitForHits(1);
    await settle(3_000);
    expect(hits).toHaveLength(1);
    await rt.stop();
  });

  it("computes occurrences in UTC and stops cleanly right after definition", async () => {
    const rt = createCronRuntime({ stream, prefix, replica: "utc" });
    const [job] = registerVercelCrons({ baseUrl, runtime: rt, configPath: configWith([{ path: "/api/utc", schedule: "30 5 * * *" }]) });
    expect(job!.nextRun(new Date("2026-03-08T05:30:00.000Z")).toISOString()).toBe("2026-03-09T05:30:00.000Z");
    expect(job!.nextRun(new Date("2026-11-01T00:00:00.000Z")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    await rt.stop();
  });

  it("fires one tick exactly once across two runtime instances", async () => {
    hits.length = 0;
    respond = (_req, res) => res.end("ok");
    const a = createCronRuntime({ stream, prefix, replica: "a" });
    const b = createCronRuntime({ stream, prefix, replica: "b" });
    const configPath = configWith([{ path: "/api/once", schedule: "0 9 * * *" }]);
    const [jobA] = registerVercelCrons({ configPath, baseUrl, runtime: a });
    const [jobB] = registerVercelCrons({ configPath, baseUrl, runtime: b });
    const at = new Date(Date.now() - 800);
    const results = await Promise.all([jobA!.trigger(at), jobB!.trigger(at)]);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    await waitForHits(1);
    await settle(1_500);
    expect(hits).toHaveLength(1);
    await Promise.all([a.stop(), b.stop()]);
  });

  it("fires the scheduler tick exactly once per minute with two instances", async () => {
    hits.length = 0;
    respond = (_req, res) => res.end("ok");
    const a = createCronRuntime({ stream, prefix, replica: "ta" });
    const b = createCronRuntime({ stream, prefix, replica: "tb" });
    const configPath = configWith([{ path: "/api/minute", schedule: "* * * * *" }]);
    registerVercelCrons({ configPath, baseUrl, runtime: a });
    registerVercelCrons({ configPath, baseUrl, runtime: b });
    await waitForHits(1, 75_000);
    await settle(2_000);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.headers["x-vercel-cron-schedule"]).toBe("* * * * *");
    await Promise.all([a.stop(), b.stop()]);
  }, 100_000);
});

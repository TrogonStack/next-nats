import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats } from "../../src/connection.js";
import { consoleLogger, setLogger, silentLogger } from "../../src/logger.js";
import {
  defineService,
  discover,
  endpoint,
  EndpointError,
  serviceClient,
  ServiceCallError,
  stopAllServices,
} from "../../src/services/index.js";

const run = Math.random().toString(36).slice(2, 8);

const math = defineService({
  name: `math-${run}`,
  version: "1.2.3",
  description: "test math",
  instances: 3,
  endpoints: {
    add: endpoint({
      input: (raw): { a: number; b: number } => {
        const v = raw as { a?: unknown; b?: unknown };
        if (typeof v?.a !== "number" || typeof v?.b !== "number") throw new Error("a and b must be numbers");
        return { a: v.a, b: v.b };
      },
      handler: ({ a, b }) => ({ sum: a + b }),
    }),
    divide: endpoint({
      handler: ({ a, b }: { a: number; b: number }) => {
        if (b === 0) throw new EndpointError(422, "Division by zero");
        return { quotient: a / b };
      },
    }),
    boom: endpoint({
      handler: (): never => {
        throw new Error("kaput");
      },
    }),
    slow: endpoint({
      handler: async (ms: number) => {
        await new Promise((r) => setTimeout(r, ms));
        return "done";
      },
    }),
    ping: endpoint({ handler: () => undefined }),
    custom: endpoint({ subject: `custom.${run}.where`, handler: () => "here" }),
  },
});

const broadcast = defineService({
  name: `probe-${run}`,
  version: "0.1.0",
  queue: "",
  instances: 3,
  endpoints: {
    whoami: endpoint({ handler: (_: void, ctx) => ({ instance: ctx.instance }) }),
    flaky: endpoint({
      handler: (_: void, ctx) => {
        if (ctx.instance.charCodeAt(0) % 2 === 0) return "ok";
        throw new EndpointError(503, "unhealthy");
      },
    }),
  },
});

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_URL, workers: true, name: "next-nats-services-test" });
  await math.start();
  await broadcast.start();
});

afterAll(async () => {
  await stopAllServices();
  await closeNats();
});

describe("services request/reply", () => {
  const client = serviceClient<typeof math>(math);

  it("returns typed output", async () => {
    const out: { sum: number } = await client.add({ a: 2, b: 3 });
    expect(out).toEqual({ sum: 5 });
    expect(await client.divide({ a: 9, b: 3 })).toEqual({ quotient: 3 });
  });

  it("works from a name alone", async () => {
    const byName = serviceClient<typeof math>(`math-${run}`);
    expect(await byName.add({ a: 1, b: 1 })).toEqual({ sum: 2 });
  });

  it("maps validation failures to 400", async () => {
    const error = await client.add({ a: "x" as unknown as number, b: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceCallError);
    expect(error).toMatchObject({ code: 400, kind: "service", endpoint: "add", message: "a and b must be numbers" });
  });

  it("maps EndpointError codes", async () => {
    const error = await client.divide({ a: 1, b: 0 }).catch((e) => e);
    expect(error).toMatchObject({ code: 422, kind: "service", message: "Division by zero" });
  });

  it("maps thrown errors to 500 without leaking the internal message", async () => {
    const logged: unknown[] = [];
    setLogger({ ...silentLogger, error: (_message, context) => void logged.push(context?.error) });
    try {
      const error = await client.boom().catch((e) => e);
      expect(error).toMatchObject({ code: 500, kind: "service", message: "An internal error occurred" });
      expect(JSON.stringify(error.toPublic())).not.toContain("kaput");
      expect(logged.some((e) => e instanceof Error && e.message === "kaput")).toBe(true);
    } finally {
      setLogger(consoleLogger());
    }
  });

  it("maps request timeouts to 408", async () => {
    const error = await client.slow(500, { timeout: 100 }).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceCallError);
    expect(error).toMatchObject({ code: 408, kind: "timeout" });
  });

  it("maps missing responders to 503", async () => {
    const ghost = serviceClient(`ghost-${run}`);
    const error = await ghost.nothing!({}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 503, kind: "unavailable" });
  });

  it("supports empty replies and custom subjects", async () => {
    expect(await client.ping()).toBeUndefined();
    expect(await client.custom()).toBe("here");
    expect(client.custom.subject).toBe(`custom.${run}.where`);
  });

  it("answers a queue-grouped endpoint from a single instance", async () => {
    const replies = await client.add.gather({ a: 1, b: 1 }, { maxWait: 300 });
    expect(replies).toHaveLength(1);
  });
});

describe("services scatter-gather", () => {
  const client = serviceClient<typeof broadcast>(broadcast);

  it("collects one reply per instance", async () => {
    const replies = await client.whoami.gather(undefined, { maxWait: 500 });
    const ids = replies.map((r) => (r.ok ? r.value.instance : "err"));
    expect(new Set(ids).size).toBe(3);
    expect(replies.every((r) => r.ok && r.instance === r.value.instance)).toBe(true);
  });

  it("stops early at maxMessages", async () => {
    const started = Date.now();
    const replies = await client.whoami.gather(undefined, { maxMessages: 2, maxWait: 3_000 });
    expect(replies).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports per-instance failures without throwing", async () => {
    const replies = await client.flaky.gather(undefined, { maxWait: 500 });
    expect(replies).toHaveLength(3);
    for (const r of replies) {
      if (!r.ok) expect(r.error).toMatchObject({ code: 503, message: "unhealthy" });
    }
  });
});

describe("services discovery and stats", () => {
  it("pings, describes and counts", async () => {
    const client = serviceClient<typeof math>(math);
    await client.add({ a: 1, b: 2 });
    await client.divide({ a: 1, b: 0 }).catch(() => undefined);

    const found = await discover({ name: `math-${run}`, timeout: 500 });
    expect(found.ping).toHaveLength(3);
    expect(found.info[0]).toMatchObject({ name: `math-${run}`, version: "1.2.3", description: "test math" });
    expect(found.info[0]!.endpoints.map((e) => e.name).sort()).toEqual(
      ["add", "boom", "custom", "divide", "ping", "slow"],
    );

    const requests = (name: string) =>
      found.stats.flatMap((s) => s.endpoints ?? []).filter((e) => e.name === name).reduce((n, e) => n + e.num_requests, 0);
    expect(requests("add")).toBeGreaterThanOrEqual(1);
    const failures = found.stats
      .flatMap((s) => s.endpoints ?? [])
      .filter((e) => e.name === "divide")
      .reduce((n, e) => n + ((e.data as { errors: number } | undefined)?.errors ?? 0), 0);
    expect(failures).toBeGreaterThanOrEqual(1);
  });
});

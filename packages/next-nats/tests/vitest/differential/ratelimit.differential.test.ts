import { Ratelimit as UpstashRatelimit } from "@upstash/ratelimit";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Ratelimit } from "../../../src/ratelimit/index.js";
import { openPair, requireProxy } from "./redis-harness.js";
import { openSourceRedis } from "./ratelimit-harness.js";
import type { Pair } from "./redis-harness.js";

const available = await requireProxy();
const SEED = Number(process.env.NEXT_NATS_PARITY_SEED ?? 20_261_025);
const PROPERTY_TIMEOUT_MS = 600_000;
const RUNS = Number(process.env.NEXT_NATS_PARITY_RUNS ?? 60);
const EPOCH = 1_800_000_000_000;

type Spec =
  | { kind: "fixedWindow"; tokens: number; window: "1 s" | "4 s" }
  | { kind: "slidingWindow"; tokens: number; window: "1 s" | "4 s" }
  | { kind: "tokenBucket"; refill: number; interval: "1 s" | "3 s"; max: number }
  | { kind: "cachedFixedWindow"; tokens: number; window: "1 s" | "4 s" };

type Step =
  | { op: "limit"; id: string; rate?: number }
  | { op: "getRemaining"; id: string }
  | { op: "resetUsedTokens"; id: string }
  | { op: "advance"; ms: number };

type Scenario = { spec: Spec; offset: number; cache: boolean; steps: Step[] };

const specArb: fc.Arbitrary<Spec> = fc.oneof(
  fc.record({ kind: fc.constant("fixedWindow" as const), tokens: fc.integer({ min: 1, max: 5 }), window: fc.constantFrom("1 s" as const, "4 s" as const) }),
  fc.record({ kind: fc.constant("slidingWindow" as const), tokens: fc.integer({ min: 1, max: 5 }), window: fc.constantFrom("1 s" as const, "4 s" as const) }),
  fc.record({
    kind: fc.constant("tokenBucket" as const),
    refill: fc.integer({ min: 1, max: 3 }),
    interval: fc.constantFrom("1 s" as const, "3 s" as const),
    max: fc.integer({ min: 1, max: 6 }),
  }),
  fc.record({ kind: fc.constant("cachedFixedWindow" as const), tokens: fc.integer({ min: 1, max: 5 }), window: fc.constantFrom("1 s" as const, "4 s" as const) }),
);

const idArb = fc.constantFrom("u1", "u2");
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ op: fc.constant("limit" as const), id: idArb }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("limit" as const), id: idArb, rate: fc.constantFrom(2, 3, 0, -1) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("getRemaining" as const), id: idArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("resetUsedTokens" as const), id: idArb }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant("advance" as const), ms: fc.constantFrom(1, 137, 400, 997, 1003, 1500, 2501, 3999, 4001, 9000) }) },
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  spec: specArb,
  offset: fc.integer({ min: 0, max: 3999 }),
  cache: fc.boolean(),
  steps: fc.array(stepArb, { minLength: 1, maxLength: 25 }),
});

function limiterOf(spec: Spec, lib: typeof Ratelimit | typeof UpstashRatelimit) {
  switch (spec.kind) {
    case "fixedWindow":
      return lib.fixedWindow(spec.tokens, spec.window);
    case "slidingWindow":
      return lib.slidingWindow(spec.tokens, spec.window);
    case "tokenBucket":
      return lib.tokenBucket(spec.refill, spec.interval, spec.max);
    case "cachedFixedWindow":
      return lib.cachedFixedWindow(spec.tokens, spec.window);
  }
}

type Limiter = {
  limit(id: string, req?: { rate?: number }): Promise<{ pending: Promise<unknown> } & Record<string, unknown>>;
  getRemaining(id: string): Promise<unknown>;
  resetUsedTokens(id: string): Promise<void>;
};

async function settleValue(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return { threw: (error as Error).message };
  }
}

async function apply(limiter: Limiter, step: Step): Promise<unknown> {
  return settleValue(async () => {
    if (step.op === "limit") {
      const { pending, ...response } = await limiter.limit(step.id, step.rate === undefined ? undefined : { rate: step.rate });
      await pending;
      return response;
    }
    if (step.op === "getRemaining") return limiter.getRemaining(step.id);
    if (step.op === "resetUsedTokens") return limiter.resetUsedTokens(step.id);
    return undefined;
  });
}

const TTL_GRANULARITY_MS = 1000;
const TTL_SLACK_MS = 1500;

class LogicalExpiry {
  private readonly expiry = new Map<string, number>();

  constructor(
    private readonly real: Pair["real"],
    private now: number,
  ) {}

  async sync(refreshed: (key: string) => boolean): Promise<void> {
    const keys = new Set(await this.real.keys("*"));
    for (const key of this.expiry.keys()) if (!keys.has(key)) this.expiry.delete(key);
    for (const key of keys) {
      if (this.expiry.has(key) && !refreshed(key)) continue;
      const ttl = await this.real.pttl(key);
      if (ttl <= 0) continue;
      this.expiry.set(key, this.now + Math.ceil(ttl / TTL_GRANULARITY_MS) * TTL_GRANULARITY_MS);
    }
  }

  async advance(ms: number): Promise<void> {
    this.now += ms;
    for (const [key, at] of this.expiry) {
      if (at <= this.now) {
        await this.real.del(key);
        this.expiry.delete(key);
      } else {
        await this.real.pexpire(key, at - this.now + TTL_SLACK_MS);
      }
    }
  }
}

describe.skipIf(!available)("ratelimit differential against @upstash/ratelimit", () => {
  let pair: Pair;
  beforeAll(async () => {
    pair = await openPair();
  });
  afterAll(async () => {
    await pair.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches on generated request sequences for every algorithm", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ spec, offset, cache, steps }) => {
        await pair.reset();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(EPOCH + offset);
        const common = { prefix: "parity", analytics: false, ephemeralCache: cache ? new Map<string, number>() : (false as const) };
        const real = new UpstashRatelimit({
          redis: openSourceRedis(pair.real),
          limiter: limiterOf(spec, UpstashRatelimit) as never,
          enableTelemetry: false,
          ...common,
          ...(cache && { ephemeralCache: new Map<string, number>() }),
        }) as unknown as Limiter;
        const ours = new Ratelimit({
          redis: pair.ours,
          limiter: limiterOf(spec, Ratelimit) as never,
          enableTelemetry: false,
          ...common,
          ...(cache && { ephemeralCache: new Map<string, number>() }),
        }) as unknown as Limiter;
        const trace: string[] = [];
        const clock = new LogicalExpiry(pair.real, EPOCH + offset);
        for (const [index, step] of steps.entries()) {
          trace.push(`${index}:${JSON.stringify(step)}`);
          if (step.op === "advance") {
            await clock.advance(step.ms);
            vi.setSystemTime(Date.now() + step.ms);
            continue;
          }
          const expected = await apply(real, step);
          const actual = await apply(ours, step);
          const wrote = step.op === "limit" && (expected as { success?: boolean }).success === true;
          const touched = wrote ? `:${step.id}` : undefined;
          await clock.sync((key) => spec.kind === "tokenBucket" && touched !== undefined && key.endsWith(touched));
          expect(actual, `${JSON.stringify(spec)} offset ${offset} cache ${cache}\n${trace.join("\n")}`).toEqual(expected);
        }
      }),
      { seed: SEED, numRuns: RUNS, endOnFailure: false },
    );
  }, PROPERTY_TIMEOUT_MS);
});

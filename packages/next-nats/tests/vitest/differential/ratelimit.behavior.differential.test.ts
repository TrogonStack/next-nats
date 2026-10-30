import { Ratelimit as UpstashRatelimit } from "@upstash/ratelimit";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { internals } from "../../../src/redis/redis.js";
import { Ratelimit } from "../../../src/ratelimit/index.js";
import { openSourceRedis, withLatency } from "./ratelimit-harness.js";
import { openPair, requireProxy } from "./redis-harness.js";
import type { Pair } from "./redis-harness.js";

const available = await requireProxy();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Lib = typeof Ratelimit | typeof UpstashRatelimit;
type Limiter = InstanceType<typeof Ratelimit>;

async function thrown(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe.skipIf(!available)("ratelimit behavior differential against @upstash/ratelimit", () => {
  let pair: Pair;
  beforeAll(async () => {
    pair = await openPair();
  });
  afterAll(async () => {
    await pair.close();
  });
  beforeEach(async () => {
    await pair.reset();
  });

  function build(lib: Lib, limiter: (l: Lib) => ReturnType<Lib["fixedWindow"]>, extra: Record<string, unknown> = {}) {
    const redis = lib === Ratelimit ? pair.ours : openSourceRedis(pair.real);
    return new (lib as unknown as new (config: Record<string, unknown>) => Limiter)({
      redis,
      limiter: limiter(lib),
      prefix: "behavior",
      analytics: false,
      enableTelemetry: false,
      ...extra,
    });
  }

  describe("window size parsing", () => {
    const firstLimit = (lib: Lib, window: string) => async () => {
      const rl = build(lib, (l) => l.fixedWindow(2, window as "1 s"));
      const first = await rl.limit("w");
      return { success: first.success, remaining: first.remaining, span: first.reset - Date.now() > 0 };
    };

    it("observes the same span wherever in the window the first request lands", async () => {
      const window = 1500;
      const boundary = (Math.floor(Date.now() / window) + 10) * window;
      const observeFrom = async (start: number) => {
        let now = start;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
        try {
          return await firstLimit(UpstashRatelimit, "1.5 s")();
        } finally {
          clock.mockRestore();
        }
      };
      expect(await observeFrom(boundary - 1)).toEqual(await observeFrom(boundary + window / 2));
    });

    const cases = ["abc", "0 s", "0.0004 ms", "1.5 s", "10s", "2 h", "1 w", "", "5 minutes", "-1 s", ".5 s"];
    for (const window of cases) {
      it(`fixedWindow(2, ${JSON.stringify(window)})`, async () => {
        const real = await thrown(firstLimit(UpstashRatelimit, window));
        const ours = await thrown(firstLimit(Ratelimit, window));
        expect(ours).toEqual(real);
        if (real === undefined) expect(await firstLimit(Ratelimit, window)()).toEqual(await firstLimit(UpstashRatelimit, window)());
      });
    }
  });

  describe("blockUntilReady", () => {
    it("rejects a non-positive timeout with the same message", async () => {
      for (const timeout of [0, -5]) {
        const real = await thrown(() => build(UpstashRatelimit, (l) => l.fixedWindow(1, "1 s")).blockUntilReady("b", timeout));
        const ours = await thrown(() => build(Ratelimit, (l) => l.fixedWindow(1, "1 s")).blockUntilReady("b", timeout));
        expect(ours).toBe(real);
      }
    });

    it("waits for the window to reset and then succeeds", async () => {
      const observe = async (lib: Lib) => {
        await pair.reset();
        const rl = build(lib, (l) => l.fixedWindow(1, "600 ms"));
        await (await rl.limit("b")).pending;
        const started = Date.now();
        const res = await rl.blockUntilReady("b", 3000);
        return { success: res.success, elapsed: Date.now() - started };
      };
      const real = await observe(UpstashRatelimit);
      const ours = await observe(Ratelimit);
      expect(ours.success).toBe(real.success);
      expect(real.success).toBe(true);
      for (const { elapsed } of [real, ours]) expect(elapsed).toBeLessThan(1500);
    });

    it("gives up at the deadline when the window outlives the timeout", async () => {
      const observe = async (lib: Lib) => {
        await pair.reset();
        const rl = build(lib, (l) => l.fixedWindow(1, "10 s"));
        await (await rl.limit("b")).pending;
        const started = Date.now();
        const res = await rl.blockUntilReady("b", 400);
        return { success: res.success, remaining: res.remaining, elapsed: Date.now() - started };
      };
      const real = await observe(UpstashRatelimit);
      const ours = await observe(Ratelimit);
      expect({ success: ours.success, remaining: ours.remaining }).toEqual({ success: real.success, remaining: real.remaining });
      expect(real.success).toBe(false);
      for (const { elapsed } of [real, ours]) {
        expect(elapsed).toBeGreaterThanOrEqual(390);
        expect(elapsed).toBeLessThan(1500);
      }
    });

    it("polls every 100 ms when the deadline has already passed", async () => {
      const observe = async (lib: Lib) => {
        await pair.reset();
        const rl = build(lib, (l) => l.fixedWindow(1, "10 s"));
        const base = 1_800_000_000_000;
        let calls = 0;
        const now = vi.spyOn(Date, "now").mockImplementation(() => base + 1000 + 5 * calls++);
        const timers = vi.spyOn(globalThis, "setTimeout");
        try {
          await (await rl.limit("b")).pending;
          const res = await rl.blockUntilReady("b", 1);
          return { success: res.success, delays: timers.mock.calls.map((call) => call[1]).filter((delay) => typeof delay === "number" && delay <= 1000) };
        } finally {
          now.mockRestore();
          timers.mockRestore();
        }
      };
      const real = await observe(UpstashRatelimit);
      const ours = await observe(Ratelimit);
      expect(ours).toEqual(real);
      expect(real.delays).toContain(100);
    });
  });

  describe("dynamic limits", () => {
    const algorithms = {
      fixedWindow: (l: Lib) => l.fixedWindow(3, "60 s"),
      slidingWindow: (l: Lib) => l.slidingWindow(3, "60 s"),
      tokenBucket: (l: Lib) => l.tokenBucket(1, "60 s", 3),
    };
    for (const [name, make] of Object.entries(algorithms)) {
      it(`${name} honors setDynamicLimit and clearing it`, async () => {
        const run = async (lib: Lib) => {
          await pair.reset();
          const rl = build(lib, make, { dynamicLimits: true });
          const trace: unknown[] = [];
          trace.push(await rl.getDynamicLimit());
          await rl.setDynamicLimit({ limit: 5 });
          trace.push(await rl.getDynamicLimit());
          for (let i = 0; i < 6; i += 1) {
            const { pending, ...res } = await rl.limit("d");
            await pending;
            trace.push({ success: res.success, limit: res.limit, remaining: res.remaining });
          }
          trace.push(await rl.getRemaining("d").then(({ remaining, limit }) => ({ remaining, limit })));
          await rl.setDynamicLimit({ limit: false });
          trace.push(await rl.getDynamicLimit());
          await rl.resetUsedTokens("d");
          const { pending, ...res } = await rl.limit("d");
          await pending;
          trace.push({ success: res.success, limit: res.limit, remaining: res.remaining });
          return trace;
        };
        expect(await run(Ratelimit)).toEqual(await run(UpstashRatelimit));
      });
    }

    it("raising and lowering the limit mid-window behaves alike", async () => {
      const run = async (lib: Lib) => {
        await pair.reset();
        const rl = build(lib, algorithms.fixedWindow, { dynamicLimits: true });
        const trace: unknown[] = [];
        for (const limit of [2, 1, 10, false] as const) {
          await rl.setDynamicLimit({ limit });
          const { pending, ...res } = await rl.limit("d");
          await pending;
          trace.push({ success: res.success, limit: res.limit, remaining: res.remaining });
        }
        return trace;
      };
      expect(await run(Ratelimit)).toEqual(await run(UpstashRatelimit));
    });

    it("rejects dynamic limit calls when the option is off with the same message", async () => {
      for (const call of ["setDynamicLimit", "getDynamicLimit"] as const) {
        const real = await thrown(() => build(UpstashRatelimit, algorithms.fixedWindow)[call]({ limit: 1 }));
        const ours = await thrown(() => build(Ratelimit, algorithms.fixedWindow)[call]({ limit: 1 }));
        expect(ours).toBe(real);
        expect(real).toContain(call);
      }
    });

    it("stores the dynamic limit under the same key", async () => {
      await build(UpstashRatelimit, algorithms.fixedWindow, { dynamicLimits: true }).setDynamicLimit({ limit: 7 });
      await build(Ratelimit, algorithms.fixedWindow, { dynamicLimits: true }).setDynamicLimit({ limit: 7 });
      const realKeys = await pair.real.keys("*");
      const oursKeys = await pair.ours.keys("*");
      expect(oursKeys).toEqual(realKeys);
    });
  });

  describe("timeout", () => {
    it("answers with the timeout response when the store is slower than the timeout", async () => {
      const store = pair.ours[internals].store;
      const mutate = store.mutate.bind(store);
      const read = store.read.bind(store);
      store.mutate = (async (...args: Parameters<typeof mutate>) => {
        await sleep(400);
        return mutate(...args);
      }) as typeof store.mutate;
      store.read = (async (...args: Parameters<typeof read>) => {
        await sleep(400);
        return read(...args);
      }) as typeof store.read;
      try {
        const real = new UpstashRatelimit({
          redis: withLatency(openSourceRedis(pair.real), 400),
          limiter: UpstashRatelimit.fixedWindow(2, "60 s"),
          timeout: 80,
          analytics: false,
          enableTelemetry: false,
        });
        const ours = new Ratelimit({ redis: pair.ours, limiter: Ratelimit.fixedWindow(2, "60 s"), timeout: 80, analytics: false, enableTelemetry: false });
        const strip = ({ pending: _pending, ...rest }: Record<string, unknown>) => rest;
        const expected = strip(await real.limit("t"));
        const actual = strip(await ours.limit("t"));
        expect(actual).toEqual(expected);
        expect(expected).toMatchObject({ success: true, limit: 0, remaining: 0, reset: 0, reason: "timeout" });
        await sleep(600);
      } finally {
        store.mutate = mutate;
        store.read = read;
      }
    });

    it("timeout 0 disables the race", async () => {
      const store = pair.ours[internals].store;
      const mutate = store.mutate.bind(store);
      store.mutate = (async (...args: Parameters<typeof mutate>) => {
        await sleep(150);
        return mutate(...args);
      }) as typeof store.mutate;
      try {
        const real = new UpstashRatelimit({
          redis: withLatency(openSourceRedis(pair.real), 150),
          limiter: UpstashRatelimit.fixedWindow(2, "60 s"),
          timeout: 0,
          analytics: false,
          enableTelemetry: false,
        });
        const ours = new Ratelimit({ redis: pair.ours, limiter: Ratelimit.fixedWindow(2, "60 s"), timeout: 0, analytics: false, enableTelemetry: false });
        const a = await real.limit("t");
        const b = await ours.limit("t");
        expect({ s: b.success, r: b.remaining, l: b.limit }).toEqual({ s: a.success, r: a.remaining, l: a.limit });
        expect(a.reason).toBeUndefined();
      } finally {
        store.mutate = mutate;
      }
    });
  });

  describe("ephemeral cache", () => {
    it("cachedFixedWindow without a cache fails with the same message on every entry point", async () => {
      const make = (lib: Lib) => build(lib, (l) => l.cachedFixedWindow(2, "60 s"), { ephemeralCache: false });
      for (const call of ["limit", "getRemaining", "resetUsedTokens"] as const) {
        const real = await thrown(() => make(UpstashRatelimit)[call]("c"));
        const ours = await thrown(() => make(Ratelimit)[call]("c"));
        expect(ours).toBe(real);
        expect(real).toBe("This algorithm requires a cache");
      }
    });

    it("blocked identifiers are served from the cache with reason cacheBlock", async () => {
      const run = async (lib: Lib) => {
        await pair.reset();
        const rl = build(lib, (l) => l.fixedWindow(1, "60 s"), { ephemeralCache: new Map<string, number>() });
        const out: unknown[] = [];
        for (let i = 0; i < 4; i += 1) {
          const { pending, ...res } = await rl.limit("c");
          await pending;
          out.push({ success: res.success, remaining: res.remaining, reason: res.reason });
        }
        return out;
      };
      expect(await run(Ratelimit)).toEqual(await run(UpstashRatelimit));
    });

    it("limit without a cache never reports cacheBlock", async () => {
      const run = async (lib: Lib) => {
        await pair.reset();
        const rl = build(lib, (l) => l.fixedWindow(1, "60 s"), { ephemeralCache: false });
        const out: unknown[] = [];
        for (let i = 0; i < 3; i += 1) {
          const { pending, ...res } = await rl.limit("c");
          await pending;
          out.push({ success: res.success, remaining: res.remaining, reason: res.reason });
        }
        return out;
      };
      expect(await run(Ratelimit)).toEqual(await run(UpstashRatelimit));
    });
  });

  describe("unsupported features", () => {
    it("multi region and protection are the documented gaps", async () => {
      const { MultiRegionRatelimit, UnsupportedCommandError } = await import("../../../src/ratelimit/index.js").then(async (m) => ({
        MultiRegionRatelimit: m.MultiRegionRatelimit,
        UnsupportedCommandError: (await import("../../../src/redis/errors.js")).UnsupportedCommandError,
      }));
      expect(() => new MultiRegionRatelimit({ redis: [pair.ours], limiter: undefined as never })).toThrow(UnsupportedCommandError);
      expect(
        () => new Ratelimit({ redis: pair.ours, limiter: Ratelimit.fixedWindow(1, "1 s"), enableProtection: true }),
      ).toThrow(UnsupportedCommandError);
    });
  });
});

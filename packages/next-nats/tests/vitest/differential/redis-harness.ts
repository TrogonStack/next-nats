import { Redis as UpstashRedis } from "@upstash/redis";
import { closeNats, connectNats, getNats } from "../../../src/connection.js";
import { Redis } from "../../../src/redis/index.js";

const project = process.env.NEXT_NATS_COMPOSE_PROJECT ?? "next-nats";

export const PROXY_URL = process.env.NEXT_NATS_REDIS_HTTP_URL ?? `http://srh.${project}.orb.local`;
export const PROXY_TOKEN = process.env.SRH_TOKEN ?? "parity-token";

export async function proxyReachable(): Promise<boolean> {
  try {
    const res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${PROXY_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(["PING"]),
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function requireProxy(): Promise<boolean> {
  const reachable = await proxyReachable();
  if (!reachable && process.env.NEXT_NATS_REQUIRE_REDIS) {
    throw new Error(`the Redis HTTP proxy at ${PROXY_URL} is unreachable, run mise run parity:redis`);
  }
  return reachable;
}

export type Pair = {
  real: UpstashRedis;
  ours: Redis;
  reset(): Promise<void>;
  close(): Promise<void>;
};

export async function openPair(options: { automaticDeserialization?: boolean; enableAutoPipelining?: boolean } = {}): Promise<Pair> {
  const bucket = `par_${Math.random().toString(36).slice(2, 10)}`;
  await connectNats({ servers: process.env.NATS_URL, name: "next-nats-redis-differential" });
  const real = new UpstashRedis({
    url: PROXY_URL,
    token: PROXY_TOKEN,
    enableTelemetry: false,
    retry: false,
    ...options,
  });
  const ours = new Redis({ bucket, ...options });
  const reset = async () => {
    await real.flushall();
    await ours.flushall();
  };
  await reset();
  return {
    real,
    ours,
    reset,
    async close() {
      const { jsm } = await getNats();
      await jsm.streams.delete(`KV_${bucket}`).catch(() => undefined);
      await closeNats();
    },
  };
}

export type Outcome = { ok: true; value: unknown } | { ok: false; name: string; message: string };

export async function settle(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const e = error as Error;
    return { ok: false, name: e.name, message: e.message };
  }
}

export type Call = { name: string; args: unknown[] };

export function invoke(client: unknown, { name, args }: Call): Promise<unknown> {
  const fn = (client as Record<string, (...a: unknown[]) => Promise<unknown>>)[name];
  if (typeof fn !== "function") return Promise.reject(new TypeError(`${name} is not a function`));
  return fn.apply(client, args);
}

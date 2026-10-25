"use server";

import { Ratelimit } from "next-nats/ratelimit";

export type LimitState = { lines: string[] };

const limiters = {
  sliding: new Ratelimit({ limiter: Ratelimit.slidingWindow(5, "10 s"), prefix: "demo:sliding" }),
  fixed: new Ratelimit({ limiter: Ratelimit.fixedWindow(5, "10 s"), prefix: "demo:fixed" }),
  bucket: new Ratelimit({ limiter: Ratelimit.tokenBucket(1, "2 s", 5), prefix: "demo:bucket" }),
};

export async function hit(prev: LimitState, data: FormData): Promise<LimitState> {
  const algo = String(data.get("algo") ?? "sliding") as keyof typeof limiters;
  const identifier = String(data.get("identifier") ?? "").trim() || "anonymous";
  const limiter = limiters[algo] ?? limiters.sliding;
  const r = await limiter.limit(identifier);
  const secs = Math.max(0, Math.ceil((r.reset - Date.now()) / 1000));
  const line = `${algo} ${identifier}: ${r.success ? "allowed" : "BLOCKED"}, remaining ${r.remaining}/${r.limit}, reset in ${secs}s`;
  return { lines: [line, ...prev.lines].slice(0, 12) };
}

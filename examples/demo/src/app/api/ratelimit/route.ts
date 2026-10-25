import { NextResponse, type NextRequest } from "next/server";
import { kv } from "@trogonstack/next-nats/kv";
import { Ratelimit } from "@trogonstack/next-nats/ratelimit";
import { rateLimited } from "@/services/nats/http-errors";

const limiter = new Ratelimit({ redis: kv, limiter: Ratelimit.slidingWindow(5, "10 s"), prefix: "demo:route" });

export async function GET(request: NextRequest) {
  const identifier = request.headers.get("x-forwarded-for") ?? "local";
  const { success, limit, remaining, reset } = await limiter.limit(identifier);
  const headers = {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(reset),
  };
  if (!success) return rateLimited(headers);
  return NextResponse.json({ ok: true, remaining }, { headers });
}

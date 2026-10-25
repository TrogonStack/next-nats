import { NextResponse, type NextRequest } from "next/server";
import { Ratelimit } from "next-nats/ratelimit";

const limiter = new Ratelimit({ limiter: Ratelimit.slidingWindow(5, "10 s"), prefix: "demo:route" });

export async function GET(request: NextRequest) {
  const identifier = request.headers.get("x-forwarded-for") ?? "local";
  const { success, limit, remaining, reset } = await limiter.limit(identifier);
  const headers = {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(reset),
  };
  if (!success) return NextResponse.json({ error: "Too Many Requests" }, { status: 429, headers });
  return NextResponse.json({ ok: true, remaining }, { headers });
}

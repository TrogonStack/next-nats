import type { NextRequest } from "next/server";
import { getLogger } from "@trogonstack/next-nats";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  getLogger().info("vercel cron route called", { userAgent: request.headers.get("user-agent") });
  return Response.json({ ok: true });
}

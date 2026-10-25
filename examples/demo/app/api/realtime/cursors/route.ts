import { corePublish } from "next-nats";
import { sseFromSubject } from "next-nats/realtime";
import { CURSOR_SUBJECT } from "@/lib/feed";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return sseFromSubject(request, CURSOR_SUBJECT);
}

export async function POST(request: Request) {
  const body = (await request.json()) as { id?: string; x?: number; y?: number; name?: string };
  if (typeof body.id !== "string" || typeof body.x !== "number" || typeof body.y !== "number") {
    return Response.json({ error: "id, x and y are required" }, { status: 400 });
  }
  await corePublish(CURSOR_SUBJECT, { id: body.id, x: body.x, y: body.y, name: body.name ?? body.id.slice(0, 4) });
  return new Response(null, { status: 204 });
}

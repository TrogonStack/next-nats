import { connection } from "next/server";
import { corePublish } from "@trogonstack/next-nats";
import { sseFromSubject } from "@trogonstack/next-nats/realtime";
import { CURSOR_SUBJECT } from "@/services/nats/feed";
import { badRequest, readJson } from "@/services/nats/http-errors";

export async function GET(request: Request) {
  await connection();
  return sseFromSubject(request, CURSOR_SUBJECT);
}

export async function POST(request: Request) {
  await connection();
  const body = await readJson<{ id?: string; x?: number; y?: number; name?: string }>(request);
  if (body instanceof Response) return body;
  if (typeof body?.id !== "string" || typeof body.x !== "number" || typeof body.y !== "number") {
    return badRequest("MISSING_FIELDS", "id, x and y are required");
  }
  await corePublish(CURSOR_SUBJECT, { id: body.id, x: body.x, y: body.y, name: body.name ?? body.id.slice(0, 4) });
  return new Response(null, { status: 204 });
}

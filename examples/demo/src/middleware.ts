import { corePublish, edgeKv, edgeRequest, EdgeRequestError, edgeSseFromSubject } from "@trogonstack/next-nats/edge";

export const config = { matcher: "/api/edge/:path*" };

const EVENTS_SUBJECT = "demo.edge.events";
const bucket = () => edgeKv(process.env.NEXT_NATS_KV_BUCKET ?? "kv");

async function kv(request: Request): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key");
  if (request.method === "PUT") {
    const body = (await request.json()) as { key?: string; value?: unknown };
    if (!body.key) return Response.json({ error: "key is required" }, { status: 400 });
    return Response.json({ revision: await bucket().put(body.key, body.value) });
  }
  if (!key) return Response.json({ error: "key is required" }, { status: 400 });
  if (request.method === "DELETE") {
    await bucket().delete(key);
    return new Response(null, { status: 204 });
  }
  const entry = await bucket().get(key);
  if (!entry) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ key: entry.key, revision: entry.revision, value: entry.value });
}

async function calc(request: Request): Promise<Response> {
  const { op, a, b } = (await request.json()) as { op: "add" | "divide"; a: number; b: number };
  try {
    return Response.json((await edgeRequest(`calculator.${op}`, { a, b }, { timeout: 2_000 })).json());
  } catch (error) {
    if (error instanceof EdgeRequestError) return Response.json({ error: error.message, kind: error.kind }, { status: error.status });
    throw error;
  }
}

async function events(request: Request): Promise<Response> {
  if (request.method === "POST") {
    await corePublish(EVENTS_SUBJECT, await request.json());
    return new Response(null, { status: 204 });
  }
  return edgeSseFromSubject(request, EVENTS_SUBJECT);
}

export async function middleware(request: Request) {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/edge/kv") return kv(request);
  if (pathname === "/api/edge/calc") return calc(request);
  return events(request);
}

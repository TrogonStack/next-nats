import { connection } from "next/server";
import { ServiceCallError } from "next-nats/services";
import { calc } from "@/services/nats/service-clients";

export async function POST(request: Request) {
  await connection();
  const { op, a, b } = (await request.json()) as { op: "add" | "divide"; a: number; b: number };
  const client = calc();
  if (op !== "add" && op !== "divide") return Response.json({ error: "op must be add or divide" }, { status: 400 });
  try {
    return Response.json(await client[op]({ a, b }));
  } catch (error) {
    if (error instanceof ServiceCallError) {
      const status = error.kind === "service" ? error.code : error.kind === "timeout" ? 504 : 503;
      return Response.json({ error: error.message, code: error.code, kind: error.kind }, { status });
    }
    throw error;
  }
}

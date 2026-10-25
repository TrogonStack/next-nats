import { connection } from "next/server";
import { publicErrorResponse } from "next-nats";
import { ServiceCallError } from "next-nats/services";
import { badRequest, readJson } from "@/services/nats/http-errors";
import { calc } from "@/services/nats/service-clients";

export async function POST(request: Request) {
  await connection();
  const body = await readJson<{ op: "add" | "divide"; a: number; b: number }>(request);
  if (body instanceof Response) return body;
  const { op, a, b } = body;
  const client = calc();
  if (op !== "add" && op !== "divide") return badRequest("INVALID_OPERATION", "op must be add or divide", "/op");
  try {
    return Response.json(await client[op]({ a, b }));
  } catch (error) {
    if (error instanceof ServiceCallError) return publicErrorResponse(error, { status: error.kind === "service" ? error.code : undefined });
    throw error;
  }
}

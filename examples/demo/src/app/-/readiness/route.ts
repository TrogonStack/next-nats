import { connection } from "next/server";
import { GET as readiness } from "@trogonstack/next-nats/health/readiness";

export async function GET(request: Request) {
  await connection();
  return readiness(request);
}

import { connection } from "next/server";
import { GET as liveness } from "@trogonstack/next-nats/health/liveness";

export async function GET(request: Request) {
  await connection();
  return liveness(request);
}

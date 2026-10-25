import { connection } from "next/server";
import { GET as liveness } from "next-nats/health/liveness";

export async function GET(...args: Parameters<typeof liveness>) {
  await connection();
  return liveness(...args);
}

import { connection } from "next/server";
import { GET as readiness } from "@trogonstack/next-nats/health/readiness";

export async function GET(...args: Parameters<typeof readiness>) {
  await connection();
  return readiness(...args);
}

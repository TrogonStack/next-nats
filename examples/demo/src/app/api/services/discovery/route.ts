import { connection } from "next/server";
import { discover } from "@trogonstack/next-nats/services";

export async function GET() {
  await connection();
  return Response.json(await discover());
}

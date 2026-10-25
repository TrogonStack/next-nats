import { connection } from "next/server";
import { discover } from "next-nats/services";

export async function GET() {
  await connection();
  return Response.json(await discover());
}

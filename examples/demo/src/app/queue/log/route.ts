import { connection } from "next/server";
import { readQueueLog } from "@/services/nats/demo-log";

export async function GET() {
  await connection();
  return Response.json(await readQueueLog());
}

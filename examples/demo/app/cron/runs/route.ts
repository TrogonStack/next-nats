import { connection } from "next/server";
import { listCronRuns, triggerCron } from "next-nats/cron";

export async function GET() {
  await connection();
  return Response.json(await listCronRuns({ name: "demo-heartbeat", limit: 20 }));
}

export async function POST() {
  await connection();
  return Response.json(await triggerCron("demo-heartbeat"));
}

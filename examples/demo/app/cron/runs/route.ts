import { listCronRuns, triggerCron } from "next-nats/cron";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await listCronRuns({ name: "demo-heartbeat", limit: 20 }));
}

export async function POST() {
  return Response.json(await triggerCron("demo-heartbeat"));
}

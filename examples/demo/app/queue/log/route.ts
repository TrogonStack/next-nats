import { readQueueLog } from "@/lib/demo-log";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await readQueueLog());
}

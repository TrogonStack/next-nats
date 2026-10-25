import { discover } from "next-nats/services";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await discover());
}

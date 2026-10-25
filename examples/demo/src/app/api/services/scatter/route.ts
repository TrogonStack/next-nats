import { connection } from "next/server";
import { toPublicError } from "next-nats";
import { prober } from "@/services/nats/service-clients";

export async function GET() {
  await connection();
  const replies = await prober().whoami.gather(undefined, { maxWait: 500 });
  return Response.json(replies.map((r) => (r.ok ? r.value : { instance: r.instance, error: toPublicError(r.error) })));
}

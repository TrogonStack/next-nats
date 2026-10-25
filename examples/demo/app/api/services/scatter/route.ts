import { prober } from "@/lib/service-clients";

export const dynamic = "force-dynamic";

export async function GET() {
  const replies = await prober().whoami.gather(undefined, { maxWait: 500 });
  return Response.json(replies.map((r) => (r.ok ? r.value : { instance: r.instance, error: r.error.message })));
}

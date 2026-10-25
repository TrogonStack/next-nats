import { sseFromStream } from "next-nats/realtime";
import { ensureFeed, FEED_STREAM, FEED_SUBJECT } from "@/lib/feed";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureFeed();
  return sseFromStream(request, {
    stream: FEED_STREAM,
    filterSubjects: [`${FEED_SUBJECT}.>`],
    deliver: "all",
  });
}

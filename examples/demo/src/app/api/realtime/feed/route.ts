import { connection } from "next/server";
import { sseFromStream } from "next-nats/realtime";
import { ensureFeed, FEED_STREAM, FEED_SUBJECT } from "@/services/nats/feed";

export async function GET(request: Request) {
  await connection();
  await ensureFeed();
  return sseFromStream(request, {
    stream: FEED_STREAM,
    filterSubjects: [`${FEED_SUBJECT}.>`],
    deliver: "all",
  });
}

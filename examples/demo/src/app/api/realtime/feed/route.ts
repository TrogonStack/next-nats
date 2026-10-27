import { connection } from "next/server";
import { sseFromStream } from "@trogonstack/next-nats/realtime";
import { unavailable } from "@/services/nats/http-errors";
import { ensureFeed, FEED_STREAM, FEED_SUBJECT } from "@/services/nats/feed";

export async function GET(request: Request) {
  await connection();
  try {
    await ensureFeed();
  } catch {
    return unavailable("FEED_STREAM_UNAVAILABLE", "The feed stream could not be provisioned");
  }
  return sseFromStream(request, {
    stream: FEED_STREAM,
    filterSubjects: [`${FEED_SUBJECT}.>`],
    deliver: "all",
  });
}

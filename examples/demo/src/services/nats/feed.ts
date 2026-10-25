import { ensureStream } from "@trogonstack/next-nats";

export const FEED_STREAM = "DEMO_FEED";
export const FEED_SUBJECT = "demo.feed";
export const CURSOR_SUBJECT = "demo.cursors";

let ready: Promise<unknown> | undefined;

export function ensureFeed() {
  ready ??= ensureStream({ name: FEED_STREAM, subjects: [`${FEED_SUBJECT}.>`], max_msgs: 100 }).catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

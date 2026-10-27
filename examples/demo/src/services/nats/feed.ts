import { ensureStreamOnce } from "@trogonstack/next-nats";

export const FEED_STREAM = "DEMO_FEED";
export const FEED_SUBJECT = "demo.feed";
export const CURSOR_SUBJECT = "demo.cursors";

export const ensureFeed = ensureStreamOnce({ name: FEED_STREAM, subjects: [`${FEED_SUBJECT}.>`], max_msgs: 100 });

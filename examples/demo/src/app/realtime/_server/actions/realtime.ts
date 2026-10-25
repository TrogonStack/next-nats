"use server";
import "server-only";

import { jsPublish } from "next-nats";
import { ensureFeed, FEED_SUBJECT } from "@/services/nats/feed";

export async function publishFeed(formData: FormData): Promise<void> {
  const text = String(formData.get("text") ?? "").trim();
  if (!text) return;
  await ensureFeed();
  await jsPublish(`${FEED_SUBJECT}.message`, { text, at: new Date().toISOString() });
}

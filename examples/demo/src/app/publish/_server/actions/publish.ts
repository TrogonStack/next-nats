"use server";
import "server-only";

import { jsPublish } from "@trogonstack/next-nats";
import { DEMO_SUBJECT } from "@/constants/demo";
import { ensureEvents } from "@/services/nats/events";

export type PublishState = { ok: boolean; message: string };

export async function publishEvent(_prev: PublishState, formData: FormData): Promise<PublishState> {
  const message = String(formData.get("message") ?? "").trim();
  if (!message) return { ok: false, message: "Message is required" };
  await ensureEvents();
  const ack = await jsPublish(`${DEMO_SUBJECT}.created`, { message, fail: formData.get("fail") === "on" });
  return { ok: true, message: `Published to ${ack.stream} at seq ${ack.seq}` };
}

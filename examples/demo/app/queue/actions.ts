"use server";

import { send } from "next-nats/queue";
import { DEMO_QUEUE_TOPIC } from "@/lib/demo";

export type EnqueueState = { message: string };

export async function enqueue(_prev: EnqueueState, formData: FormData): Promise<EnqueueState> {
  const text = String(formData.get("text") ?? "").trim();
  if (!text) return { message: "Text is required" };
  const delaySeconds = Number(formData.get("delay") ?? 0) || 0;
  const { messageId } = await send(
    DEMO_QUEUE_TOPIC,
    { text, fail: formData.get("fail") === "on" },
    { delaySeconds },
  );
  return { message: `Enqueued ${messageId}${delaySeconds ? ` with ${delaySeconds}s delay` : ""}` };
}

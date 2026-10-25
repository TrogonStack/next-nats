import { handleCallback } from "@vercel/queue";
import { appendQueueLog } from "@/services/nats/demo-log";

type Job = { text: string; fail?: boolean };

const callback = handleCallback<Job>(
  async (payload, metadata) => {
    const failing = payload.fail && metadata.deliveryCount < 3;
    await appendQueueLog({
      at: new Date().toISOString(),
      messageId: metadata.messageId,
      text: payload.text,
      deliveryCount: metadata.deliveryCount,
      outcome: failing ? "failed" : "processed",
    });
    if (failing) throw new Error("demo queue failure");
  },
  { retry: () => ({ afterSeconds: 2 }) },
);

export function POST(request: Request) {
  return callback(request);
}

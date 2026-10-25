import { defineConsumer, ensureStream } from "next-nats";
import { defineCron } from "next-nats/cron";
import { subscribe } from "next-nats/queue";
import { DEMO_DLQ, DEMO_QUEUE_GROUP, DEMO_QUEUE_TOPIC, DEMO_STREAM, DEMO_SUBJECT } from "./demo";
import { appendQueueLog } from "./demo-log";

await ensureStream({ name: DEMO_STREAM, subjects: [`${DEMO_SUBJECT}.>`, DEMO_DLQ] });

defineConsumer<{ message: string; fail?: boolean }>({
  stream: DEMO_STREAM,
  durable: "demo-logger",
  filterSubjects: [`${DEMO_SUBJECT}.>`],
  maxDeliver: 3,
  backoff: [500, 1_000],
  deadLetter: { subject: DEMO_DLQ },
  handler(payload) {
    if (payload.fail) throw new Error("demo failure");
    console.log("[demo] received", payload.message);
  },
});

subscribe<{ text: string; fail?: boolean }>(
  DEMO_QUEUE_TOPIC,
  DEMO_QUEUE_GROUP,
  async (payload, meta) => {
    const failing = payload.fail && meta.deliveryCount < 3;
    await appendQueueLog({
      at: new Date().toISOString(),
      messageId: meta.messageId,
      text: payload.text,
      deliveryCount: meta.deliveryCount,
      outcome: failing ? "failed" : "processed",
    });
    if (failing) throw new Error("demo queue failure");
  },
  { retry: () => ({ afterSeconds: 2 }) },
);

defineCron({
  name: "demo-heartbeat",
  schedule: "* * * * *",
  handler: ({ scheduledAt, replica }) => {
    console.log("[demo] cron tick", scheduledAt.toISOString(), replica);
  },
});

await import("./realtime-services");

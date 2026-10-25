import { defineConsumer, ensureStream, getLogger } from "@trogonstack/next-nats";
import { defineCron } from "@trogonstack/next-nats/cron";
import { startQueueWorker } from "@trogonstack/next-nats/queue";
import { DEMO_DLQ, DEMO_STREAM, DEMO_SUBJECT } from "@/constants/demo";

await ensureStream({ name: DEMO_STREAM, subjects: [`${DEMO_SUBJECT}.>`, DEMO_DLQ] });

defineConsumer<{ message: string; fail?: boolean }>({
  stream: DEMO_STREAM,
  durable: "event-logger",
  filterSubjects: [`${DEMO_SUBJECT}.>`],
  maxDeliver: 3,
  backoff: [500, 1_000],
  deadLetter: { subject: DEMO_DLQ },
  handler(payload) {
    if (payload.fail) throw new Error("demo failure");
    getLogger().info("demo event received", { message: payload.message });
  },
});

startQueueWorker();

defineCron({
  name: "heartbeat-beater",
  schedule: "* * * * *",
  handler: ({ scheduledAt, replica }) => {
    getLogger().debug("demo cron tick", { scheduledAt: scheduledAt.toISOString(), replica });
  },
});

await import("./realtime-services");

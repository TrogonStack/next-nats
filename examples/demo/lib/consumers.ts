import { defineConsumer, ensureStream } from "next-nats";
import { DEMO_DLQ, DEMO_STREAM, DEMO_SUBJECT } from "./demo";

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
await import("./realtime-services");

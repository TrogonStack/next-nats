import { openKv } from "next-nats";

const BUCKET = "demo_queue_log";

const bucket = () => openKv(BUCKET, { history: 1, ttl: 3_600_000 });

export interface QueueLogLine {
  at: string;
  messageId: string;
  text: string;
  deliveryCount: number;
  outcome: "processed" | "failed";
}

export async function appendQueueLog(line: QueueLogLine): Promise<void> {
  const kv = await bucket();
  await kv.put(`${Date.now()}_${line.messageId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12)}_${line.deliveryCount}`, JSON.stringify(line));
}

export async function readQueueLog(limit = 30): Promise<QueueLogLine[]> {
  const kv = await bucket();
  const keys: string[] = [];
  for await (const key of await kv.keys()) keys.push(key);
  keys.sort().reverse();
  const lines: QueueLogLine[] = [];
  for (const key of keys.slice(0, limit)) {
    const entry = await kv.get(key);
    if (entry && entry.operation === "PUT") lines.push(JSON.parse(entry.string()) as QueueLogLine);
  }
  return lines;
}

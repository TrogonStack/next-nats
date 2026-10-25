import "server-only";
import { openKv } from "../connection.js";

export type CronRunStatus = "success" | "failed" | "skipped";

export interface CronRun {
  name: string;
  scheduledAt: string;
  startedAt: string;
  finishedAt: string;
  status: CronRunStatus;
  replica: string;
  deliveryCount: number;
  error?: string;
}

const BUCKET = "next_nats_cron";

const bucket = () => openKv(BUCKET, { history: 1, ttl: 24 * 3_600_000 });

export async function recordCronRun(run: CronRun): Promise<void> {
  const kv = await bucket();
  await kv.put(`${run.name}.${new Date(run.scheduledAt).getTime()}`, JSON.stringify(run));
}

export async function listCronRuns(opts: { name?: string; limit?: number } = {}): Promise<CronRun[]> {
  const kv = await bucket();
  const runs: CronRun[] = [];
  const keys = await kv.keys(opts.name ? `${opts.name}.*` : ">");
  for await (const key of keys) {
    const entry = await kv.get(key);
    if (entry && entry.operation === "PUT") runs.push(JSON.parse(entry.string()) as CronRun);
  }
  runs.sort((a, b) => (a.scheduledAt < b.scheduledAt ? 1 : a.scheduledAt > b.scheduledAt ? -1 : 0));
  return runs.slice(0, opts.limit ?? 20);
}

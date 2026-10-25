import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../src/connection.js";
import { createCronRuntime, listCronRuns, nextOccurrence, validateSchedule } from "../src/cron/index.js";

const run = Math.random().toString(36).slice(2, 8);
const stream = `CRON_${run}`;
const prefix = `cron${run}`;

async function waitFor(fn: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, workers: true, name: "next-nats-cron-test" });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(stream).catch(() => undefined);
  await closeNats();
});

describe("cron", () => {
  it("parses schedules with timezones", () => {
    const from = new Date("2026-01-01T00:02:00Z");
    expect(nextOccurrence("*/5 * * * *", from).toISOString()).toBe("2026-01-01T00:05:00.000Z");
    expect(nextOccurrence("0 9 * * *", from, "America/New_York").toISOString()).toBe("2026-01-01T14:00:00.000Z");
    expect(() => validateSchedule("not a cron")).toThrow();
  });

  it("fires each tick exactly once across two replicas", async () => {
    const a = createCronRuntime({ stream, prefix, replica: "a" });
    const b = createCronRuntime({ stream, prefix, replica: "b" });
    const fired: { replica: string; tick: number }[] = [];
    const handler = (replica: string) => ({ scheduledAt }: { scheduledAt: Date }) => void fired.push({ replica, tick: scheduledAt.getTime() });
    const jobA = a.defineCron({ name: "every2", schedule: "*/2 * * * * *", handler: handler("a") });
    const jobB = b.defineCron({ name: "every2", schedule: "*/2 * * * * *", handler: handler("b") });
    await waitFor(() => fired.length >= 4);
    await Promise.all([jobA.stop(), jobB.stop()]);
    await new Promise((r) => setTimeout(r, 500));

    const ticks = fired.map((f) => f.tick);
    expect(new Set(ticks).size).toBe(ticks.length);
    for (const tick of ticks) expect(tick % 2000).toBe(0);
    const { jsm } = await getNats();
    const info = await jsm.streams.info(stream);
    expect(info.state.messages).toBeGreaterThanOrEqual(ticks.length);
    expect(info.state.messages).toBeLessThanOrEqual(ticks.length + 1);

    const runs = await listCronRuns({ name: "every2" });
    expect(runs.length).toBeGreaterThanOrEqual(4);
    expect(runs.every((r) => r.status === "success")).toBe(true);
    expect(new Set(runs.map((r) => r.replica)).size).toBeGreaterThanOrEqual(1);
    await a.stop();
    await b.stop();
  }, 40_000);

  it("retries a failing tick and records final failure", async () => {
    const rt = createCronRuntime({ stream, prefix, replica: "r" });
    let attempts = 0;
    const job = rt.defineCron({
      name: "flaky",
      schedule: "0 0 1 1 *",
      retryDelayMs: 100,
      maxDeliver: 3,
      handler: () => {
        attempts++;
        throw new Error("down");
      },
    });
    const tickAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const first = await job.trigger(tickAt);
    const second = await job.trigger(tickAt);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    await waitFor(() => attempts === 3);
    await new Promise((r) => setTimeout(r, 300));
    const [last] = await listCronRuns({ name: "flaky" });
    expect(last?.status).toBe("failed");
    expect(last?.deliveryCount).toBe(3);
    await rt.stop();
  });

  it("skips ticks that are too late", async () => {
    const rt = createCronRuntime({ stream, prefix, replica: "late" });
    let ran = 0;
    const job = rt.defineCron({ name: "late", schedule: "0 0 1 1 *", maxLatenessMs: 1_000, handler: () => void ran++ });
    await job.trigger(new Date(Date.now() - 60_000));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(ran).toBe(0);
    const [last] = await listCronRuns({ name: "late" });
    expect(last?.status).toBe("skipped");
    await rt.stop();
  });
});

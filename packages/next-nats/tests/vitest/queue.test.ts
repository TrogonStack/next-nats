import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { createQueueClient, type MessageMetadata } from "../../src/queue/index.js";

const run = Math.random().toString(36).slice(2, 8);
const stream = `Q_${run}`;
const q = createQueueClient({ stream, prefix: `q${run}` });

async function waitFor(fn: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, workers: true, name: "next-nats-queue-test" });
});

afterAll(async () => {
  await q.stop();
  const { jsm } = await getNats();
  await jsm.streams.delete(stream).catch(() => undefined);
  await closeNats();
});

describe("queue", () => {
  it("delivers at least once with retry and metadata", async () => {
    const attempts: MessageMetadata[] = [];
    const retries: unknown[] = [];
    const sub = q.subscribe<{ n: number }>(
      "orders.created",
      "billing",
      (payload, meta) => {
        attempts.push(meta);
        if (meta.deliveryCount < 3) throw new Error(`boom ${meta.deliveryCount}`);
        expect(payload).toEqual({ n: 1 });
      },
      { retry: (error, meta) => (retries.push(error), { afterSeconds: 0.1 * meta.deliveryCount }) },
    );
    const { messageId } = await q.send("orders.created", { n: 1 }, { headers: { tenant: "a" } });
    await waitFor(() => attempts.length === 3);
    expect(attempts.map((a) => a.deliveryCount)).toEqual([1, 2, 3]);
    expect(attempts[0]!.messageId).toBe(messageId);
    expect(attempts[0]!.topicName).toBe("orders.created");
    expect(attempts[0]!.consumerGroup).toBe("billing");
    expect(attempts[0]!.headers).toEqual({ tenant: "a" });
    expect(retries).toHaveLength(2);
    await sub.stop();
  });

  it("dedupes by idempotency key", async () => {
    const a = await q.send("dedupe", { v: 1 }, { idempotencyKey: "k1" });
    const b = await q.send("dedupe", { v: 2 }, { idempotencyKey: "k1" });
    expect(a.messageId).toBe("k1");
    expect(b.messageId).toBe("k1");
    const seen: unknown[] = [];
    const sub = q.subscribe("dedupe", "g", (p) => void seen.push(p));
    await waitFor(() => seen.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual([{ v: 1 }]);
    await sub.stop();
  });

  it("delays delivery", async () => {
    let at = 0;
    const sub = q.subscribe("delayed", "g", () => void (at = Date.now()));
    const sent = Date.now();
    await q.send("delayed", "later", { delaySeconds: 2 });
    await new Promise((r) => setTimeout(r, 700));
    expect(at).toBe(0);
    await waitFor(() => at > 0);
    expect(at - sent).toBeGreaterThanOrEqual(1_900);
    expect(at - sent).toBeLessThan(5_000);
    await sub.stop();
  });

  it("shares work within a group and fans out across groups", async () => {
    const a1: number[] = [];
    const a2: number[] = [];
    const other: number[] = [];
    const replica = createQueueClient({ stream, prefix: `q${run}` });
    const s = [
      q.subscribe<number>("fan", "workers", (n) => void a1.push(n), { concurrency: 2 }),
      replica.subscribe<number>("fan", "workers", (n) => void a2.push(n)),
      q.subscribe<number>("fan", "audit", (n) => void other.push(n)),
    ];
    await q.sendBatch("fan", Array.from({ length: 20 }, (_, i) => ({ payload: i })));
    await waitFor(() => a1.length + a2.length === 20 && other.length === 20);
    expect(new Set([...a1, ...a2]).size).toBe(20);
    expect(other.sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    await Promise.all(s.map((x) => x.stop()));
    expect(a1.length).toBeGreaterThan(0);
    expect(a2.length).toBeGreaterThan(0);
  });

  it("dead letters after max deliveries and supports binary payloads", async () => {
    const { jsm } = await getNats();
    let tries = 0;
    const sub = q.subscribe("poison", "g", () => {
      tries++;
      throw new Error("nope");
    }, { maxDeliveries: 2, retry: () => ({ afterSeconds: 0 }) });
    await q.send("poison", Buffer.from("bytes"));
    await waitFor(() => tries === 2);
    await new Promise((r) => setTimeout(r, 300));
    const info = await jsm.streams.getMessage(stream, { last_by_subj: `q${run}.d.poison` });
    expect(info?.header.get("x-dead-letter-deliveries")).toBe("2");
    await sub.stop();
  });

  it("receive pulls one message on demand", async () => {
    expect(await q.receive("pull", "g", () => undefined)).toEqual({ ok: false, reason: "empty" });
    await q.send("pull", { x: 1 });
    const got: unknown[] = [];
    const res = await q.receive("pull", "g", (p) => void got.push(p));
    expect(res).toEqual({ ok: true, processed: 1 });
    expect(got).toEqual([{ x: 1 }]);
  });

  it("extends visibility while a long handler runs", async () => {
    const deliveries: number[] = [];
    const sub = q.subscribe("slow", "g", async (_p, meta) => {
      deliveries.push(meta.deliveryCount);
      await new Promise((r) => setTimeout(r, 3_500));
    }, { visibilityTimeoutSeconds: 2 });
    await q.send("slow", "x");
    await waitFor(() => deliveries.length > 0);
    await new Promise((r) => setTimeout(r, 4_500));
    expect(deliveries).toEqual([1]);
    await sub.stop();
  }, 30_000);
});

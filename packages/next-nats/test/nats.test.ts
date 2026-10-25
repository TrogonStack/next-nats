import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AckPolicy } from "@nats-io/jetstream";
import { codec } from "../src/codec.js";
import { closeNats, connectNats, getNats, openKv } from "../src/connection.js";
import { defineConsumer, stopAllConsumers } from "../src/consumer.js";
import { ensureStream } from "../src/streams.js";
import { checkHealth } from "../src/health/index.js";
import { corePublish, jsPublish, request } from "../src/publish.js";

const run = Math.random().toString(36).slice(2, 8);
const STREAM = `T_${run}`;
const SUBJ = `t.${run}`;

async function waitFor(fn: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_SERVERS, workers: true, name: "next-nats-test" });
  await ensureStream({ name: STREAM, subjects: [`${SUBJ}.>`, `dlq.${run}`] });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await stopAllConsumers();
  await jsm.streams.delete(STREAM).catch(() => undefined);
  await closeNats();
});

describe("nats", () => {
  it("is healthy", async () => {
    const h = await checkHealth();
    expect(h.status).toBe("connected");
    expect(h.jetstream).toBeDefined();
  });

  it("publishes with dedup", async () => {
    const a = await jsPublish(`${SUBJ}.dedup`, { n: 1 }, { msgId: "x" });
    const b = await jsPublish(`${SUBJ}.dedup`, { n: 1 }, { msgId: "x" });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
  });

  it("request/reply", async () => {
    const { nc } = await getNats();
    const sub = nc.subscribe(`rpc.${run}`, { callback: (_e, m) => void m.respond(codec.encodeJson({ ok: true })) });
    expect(await request(`rpc.${run}`, { q: 1 })).toEqual({ ok: true });
    sub.unsubscribe();
    await corePublish(`rpc.none.${run}`, "x");
  });

  it("kv roundtrip", async () => {
    const kv = await openKv(`kv_${run}`);
    await kv.put("k", "v");
    expect((await kv.get("k"))?.string()).toBe("v");
    const { jsm } = await getNats();
    await jsm.streams.delete(`KV_kv_${run}`);
  });

  it("consumes, retries with backoff, then dead-letters", async () => {
    const seen: unknown[] = [];
    const ok: unknown[] = [];
    let attempts = 0;
    defineConsumer<{ id: number; fail?: boolean }>({
      stream: STREAM,
      durable: `d_${run}`,
      filterSubjects: [`${SUBJ}.work`],
      maxDeliver: 3,
      backoff: [100, 100],
      ackWait: 5_000,
      deadLetter: { subject: `dlq.${run}` },
      async handler(payload) {
        if (payload.fail) {
          attempts++;
          throw new Error("boom");
        }
        ok.push(payload);
      },
    });
    const { js, jsm } = await getNats();
    await js.publish(`${SUBJ}.work`, codec.encodeJson({ id: 1 }));
    await js.publish(`${SUBJ}.work`, codec.encodeJson({ id: 2, fail: true }));
    await waitFor(() => ok.length === 1 && attempts === 3);

    await jsm.consumers.add(STREAM, { durable_name: `dlqr_${run}`, ack_policy: AckPolicy.Explicit, filter_subject: `dlq.${run}` });
    const dlq = await js.consumers.get(STREAM, `dlqr_${run}`);
    const msgs = await dlq.fetch({ max_messages: 1, expires: 5_000 });
    for await (const m of msgs) {
      seen.push(m);
      expect(codec.decodeJson(m.data)).toEqual({ id: 2, fail: true });
      expect(m.headers?.get("x-dead-letter-deliveries")).toBe("3");
      m.ack();
    }
    expect(seen).toHaveLength(1);
    const info = await jsm.consumers.info(STREAM, `d_${run}`);
    expect(info.num_pending + info.num_ack_pending).toBe(0);
  });
});

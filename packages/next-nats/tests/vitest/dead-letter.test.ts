import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AckPolicy } from "@nats-io/jetstream";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { defineConsumer, stopAllConsumers } from "../../src/consumer.js";
import {
  MAX_DELIVERIES_ADVISORY_TYPE,
  MSG_TERMINATED_ADVISORY_TYPE,
  deadLetterAdvisorySubjects,
  deadLetterCaptureSpec,
  defineDeadLetterConsumer,
  ensureDeadLetterCaptureStream,
  stopAllDeadLetterConsumers,
  toDeadLetterEvent,
  type DeadLetterEvent,
  type DeadLetterOriginal,
} from "../../src/dead-letter.js";
import { jsPublish } from "../../src/publish.js";

const run = Math.random().toString(36).slice(2, 8);

const maxDeliver = {
  type: MAX_DELIVERIES_ADVISORY_TYPE,
  id: "abc",
  timestamp: "2026-01-02T03:04:05.123Z",
  stream: "ORDERS",
  consumer: "worker",
  stream_seq: 12,
  deliveries: 5,
  domain: "hub",
};

const terminated = {
  type: MSG_TERMINATED_ADVISORY_TYPE,
  id: "def",
  timestamp: "2026-01-02T03:04:05.123Z",
  stream: "ORDERS",
  consumer: "worker",
  consumer_seq: 7,
  stream_seq: 12,
  deliveries: 3,
  reason: "poison",
};

async function waitFor(fn: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("toDeadLetterEvent", () => {
  it("maps a max deliveries advisory", () => {
    expect(toDeadLetterEvent(maxDeliver)).toEqual({
      kind: "max_deliveries",
      stream: "ORDERS",
      consumer: "worker",
      streamSeq: 12,
      deliveries: 5,
      domain: "hub",
      id: "abc",
      timestamp: new Date("2026-01-02T03:04:05.123Z"),
    });
  });

  it("maps a terminated advisory with its reason", () => {
    const event = toDeadLetterEvent(terminated);
    expect(event.kind).toBe("terminated");
    expect(event.reason).toBe("poison");
    expect(event.consumerSeq).toBe(7);
    expect(event.deliveries).toBe(3);
  });

  it("omits an empty reason", () => {
    expect(toDeadLetterEvent({ ...terminated, reason: "" }).reason).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "x"],
    ["unknown type", { ...maxDeliver, type: "io.nats.jetstream.advisory.v1.nak" }],
    ["missing type", { stream: "A", consumer: "b", stream_seq: 1, deliveries: 1 }],
    ["missing stream", { ...maxDeliver, stream: undefined }],
    ["bad stream name", { ...maxDeliver, stream: "a.b" }],
    ["negative seq", { ...maxDeliver, stream_seq: -1 }],
    ["fractional deliveries", { ...maxDeliver, deliveries: 1.5 }],
    ["string seq", { ...maxDeliver, stream_seq: "1" }],
  ])("rejects %s", (_label, input) => {
    expect(() => toDeadLetterEvent(input)).toThrow(/Malformed JetStream advisory/);
  });
});

describe("advisory subjects", () => {
  it("builds the subjects documented by the server", () => {
    expect(deadLetterAdvisorySubjects("ORDERS", "worker")).toEqual([
      "$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.ORDERS.worker",
      "$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.ORDERS.worker",
    ]);
    expect(deadLetterAdvisorySubjects("ORDERS")[0]).toBe("$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.ORDERS.*");
  });

  it("builds the capture stream spec", () => {
    const spec = deadLetterCaptureSpec({ streams: ["A", "B"], maxAge: "1h" });
    expect(spec.subjects).toHaveLength(4);
    expect(spec.maxAge).toBe("1h");
    expect(deadLetterCaptureSpec().subjects).toEqual([
      "$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.*.*",
      "$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.*.*",
    ]);
  });
});

describe("dead letter consumer against NATS", () => {
  const STREAM = `DL_${run}`;
  const CAPTURE = `DLCAP_${run}`;
  const SUBJ = `dl.${run}`;

  beforeAll(async () => {
    await connectNats({ servers: process.env.NATS_URL, workers: true, name: "next-nats-dl-test" });
    const { jsm } = await getNats();
    await jsm.streams.add({ name: STREAM, subjects: [`${SUBJ}.>`] });
    await ensureDeadLetterCaptureStream({ name: CAPTURE, streams: [STREAM], maxAge: "1h" });
  });

  afterAll(async () => {
    await stopAllDeadLetterConsumers();
    await stopAllConsumers();
    const { jsm } = await getNats();
    await jsm.streams.delete(STREAM).catch(() => undefined);
    await jsm.streams.delete(CAPTURE).catch(() => undefined);
    await closeNats();
  });

  async function exhaust(consumer: string, subject: string, body: unknown) {
    const ack = await jsPublish(subject, body);
    defineConsumer({
      stream: STREAM,
      durable: consumer,
      filterSubjects: [subject],
      maxDeliver: 2,
      backoff: [100],
      handler: () => {
        throw new Error("poison");
      },
    });
    return ack;
  }

  it("delivers a terminated advisory and the original message through a captured stream", async () => {
    const seen: Array<{ event: DeadLetterEvent; original?: DeadLetterOriginal }> = [];
    const errors: unknown[] = [];
    const dl = defineDeadLetterConsumer({
      stream: STREAM,
      durable: `dlq_cap_${run}`,
      filter: `cap_${run}`,
      capture: CAPTURE,
      handler: (event, original) => void seen.push({ event, original }),
      onError: (e) => errors.push(e),
    });
    expect(dl.mode).toBe("jetstream");

    const ack = await exhaust(`cap_${run}`, `${SUBJ}.cap`, { order: 1 });
    await waitFor(() => seen.length > 0);

    const { event, original } = seen[0]!;
    expect(event.kind).toBe("terminated");
    expect(event.stream).toBe(STREAM);
    expect(event.consumer).toBe(`cap_${run}`);
    expect(event.streamSeq).toBe(ack.seq);
    expect(event.deliveries).toBe(2);
    expect(event.reason).toMatch(/maxDeliver 2 exhausted/);
    expect(original?.subject).toBe(`${SUBJ}.cap`);
    expect(original?.payload).toEqual({ order: 1 });
    expect(errors).toEqual([]);
  });

  it("falls back to a core subscription and receives live advisories", async () => {
    const seen: Array<{ event: DeadLetterEvent; original?: DeadLetterOriginal }> = [];
    const dl = defineDeadLetterConsumer({
      stream: STREAM,
      durable: `dlq_core_${run}`,
      filter: `core_${run}`,
      handler: (event, original) => void seen.push({ event, original }),
    });
    expect(dl.mode).toBe("core");
    await (await getNats()).nc.flush();
    await new Promise((r) => setTimeout(r, 100));

    const ack = await exhaust(`core_${run}`, `${SUBJ}.core`, { order: 2 });
    await waitFor(() => seen.length > 0);
    expect(seen[0]!.event.streamSeq).toBe(ack.seq);
    expect(seen[0]!.original?.payload).toEqual({ order: 2 });
  });

  it("reports a max deliveries advisory from the server", async () => {
    const seen: DeadLetterEvent[] = [];
    defineDeadLetterConsumer({
      stream: STREAM,
      durable: `dlq_md_${run}`,
      filter: `md_${run}`,
      handler: (event) => void seen.push(event),
    });
    await new Promise((r) => setTimeout(r, 100));

    const { jsm, js } = await getNats();
    const ack = await jsPublish(`${SUBJ}.md`, { n: 1 });
    await jsm.consumers.add(STREAM, {
      durable_name: `md_${run}`,
      ack_policy: AckPolicy.Explicit,
      ack_wait: 500_000_000,
      max_deliver: 1,
      filter_subject: `${SUBJ}.md`,
    });
    const consumer = await js.consumers.get(STREAM, `md_${run}`);
    const batch = await consumer.fetch({ max_messages: 1, expires: 1_000 });
    for await (const _ of batch) void _;

    await waitFor(() => seen.length > 0, 20_000);
    expect(seen[0]!.kind).toBe("max_deliveries");
    expect(seen[0]!.streamSeq).toBe(ack.seq);
    expect(seen[0]!.consumer).toBe(`md_${run}`);
  });

  it("passes undefined when the original message was already deleted", async () => {
    const seen: Array<{ event: DeadLetterEvent; original?: DeadLetterOriginal }> = [];
    const errors: unknown[] = [];
    defineDeadLetterConsumer({
      stream: STREAM,
      durable: `dlq_del_${run}`,
      filter: `del_${run}`,
      handler: (event, original) => void seen.push({ event, original }),
      onError: (e) => errors.push(e),
    });
    await new Promise((r) => setTimeout(r, 100));

    const { nc, jsm } = await getNats();
    const ack = await jsPublish(`${SUBJ}.del`, { n: 1 });
    await jsm.streams.deleteMessage(STREAM, ack.seq);
    const advisory = { ...terminated, stream: STREAM, consumer: `del_${run}`, stream_seq: ack.seq };
    nc.publish(`$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.${STREAM}.del_${run}`, JSON.stringify(advisory));
    await waitFor(() => seen.length > 0);
    expect(seen[0]!.original).toBeUndefined();
    expect(seen[0]!.event.streamSeq).toBe(ack.seq);
    expect(errors).toEqual([]);
  });

  it("reports malformed advisories without calling the handler", async () => {
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    defineDeadLetterConsumer({
      stream: STREAM,
      durable: `dlq_bad_${run}`,
      filter: `bad_${run}`,
      handler: (event) => void seen.push(event),
      onError: (e) => errors.push(e),
    });
    await new Promise((r) => setTimeout(r, 100));
    const { nc } = await getNats();
    nc.publish(`$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.${STREAM}.bad_${run}`, "not json");
    await waitFor(() => errors.length > 0);
    expect(seen).toEqual([]);
  });

  it("is deduplicated per stream and durable name and can stop", async () => {
    const def = { stream: STREAM, durable: `dlq_dup_${run}`, handler: () => {} };
    const a = defineDeadLetterConsumer(def);
    expect(defineDeadLetterConsumer(def)).toBe(a);
    await a.stop();
    expect(defineDeadLetterConsumer(def)).not.toBe(a);
  });
});

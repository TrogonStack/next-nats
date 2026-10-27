import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JetStreamApiError } from "@nats-io/jetstream";
import {
  ClosedConnectionError,
  ConnectionError,
  NoRespondersError,
  RequestError,
  TimeoutError,
  headers,
} from "@nats-io/nats-core";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { corePublish, isRetriablePublishError, jsPublish, request, retryDelay } from "../../src/publish.js";
import { TraceContext } from "../../src/trace.js";

const run = Math.random().toString(36).slice(2, 8);

describe("retry policy", () => {
  it("retries timeouts, no responders and connection drops", () => {
    expect(isRetriablePublishError(new TimeoutError())).toBe(true);
    expect(isRetriablePublishError(new NoRespondersError("s"))).toBe(true);
    expect(isRetriablePublishError(new RequestError("x", { cause: new NoRespondersError("s") }))).toBe(true);
    expect(isRetriablePublishError(new ConnectionError("x"))).toBe(true);
    expect(isRetriablePublishError(new ClosedConnectionError())).toBe(true);
    expect(isRetriablePublishError(new Error("wrapper", { cause: new TimeoutError() }))).toBe(true);
  });

  it("never retries JetStream API errors or unknown errors", () => {
    const wrongLastSeq = new JetStreamApiError({ code: 400, err_code: 10071, description: "wrong last sequence: 5" });
    expect(isRetriablePublishError(wrongLastSeq)).toBe(false);
    expect(isRetriablePublishError(new JetStreamApiError({ code: 400, err_code: 10037, description: "no message" }))).toBe(false);
    expect(isRetriablePublishError(new Error("boom"))).toBe(false);
    expect(isRetriablePublishError("string")).toBe(false);
  });

  it("computes capped, jittered exponential delays", () => {
    const none = { initial: 100, max: 1_000, multiplier: 2, jitter: 0 };
    expect(retryDelay(1, none)).toBe(100);
    expect(retryDelay(2, none)).toBe(200);
    expect(retryDelay(3, none)).toBe(400);
    expect(retryDelay(10, none)).toBe(1_000);
    expect(retryDelay(3, { ...none, jitter: 0.5 }, () => 1)).toBe(200);
    expect(retryDelay(3, { ...none, jitter: 0.5 }, () => 0)).toBe(400);
    expect(retryDelay(1, { jitter: 1 }, () => 1)).toBe(0);
  });
});

describe("jsPublish retry against NATS", () => {
  beforeAll(async () => {
    await connectNats({ servers: process.env.NATS_URL, name: "next-nats-retry-test" });
  });

  afterAll(async () => {
    await closeNats();
  });

  it("recovers once the stream appears and deduplicates with a generated message id", async () => {
    const { jsm } = await getNats();
    const name = `RETRY_${run}`;
    const subject = `retry.${run}.a`;
    setTimeout(() => void jsm.streams.add({ name, subjects: [`retry.${run}.>`] }), 400);
    try {
      const ack = await jsPublish(subject, { n: 1 }, { retry: { attempts: 8, backoff: { initial: 100, max: 300, jitter: 0 } } });
      expect(ack.stream).toBe(name);
      const stored = await jsm.streams.getMessage(name, { seq: ack.seq });
      expect(stored?.header.get("Nats-Msg-Id")).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await jsm.streams.delete(name).catch(() => undefined);
    }
  });

  it("keeps a caller supplied message id", async () => {
    const { jsm } = await getNats();
    const name = `RETRYID_${run}`;
    await jsm.streams.add({ name, subjects: [`retryid.${run}.>`] });
    try {
      const a = await jsPublish(`retryid.${run}.a`, 1, { msgId: "fixed", retry: { attempts: 3 } });
      const b = await jsPublish(`retryid.${run}.a`, 1, { msgId: "fixed", retry: { attempts: 3 } });
      expect(a.duplicate).toBe(false);
      expect(b.duplicate).toBe(true);
    } finally {
      await jsm.streams.delete(name).catch(() => undefined);
    }
  });

  it("does not set a message id when retry is off", async () => {
    const { jsm } = await getNats();
    const name = `NORETRY_${run}`;
    await jsm.streams.add({ name, subjects: [`noretry.${run}.>`] });
    try {
      const ack = await jsPublish(`noretry.${run}.a`, 1);
      const stored = await jsm.streams.getMessage(name, { seq: ack.seq });
      expect(stored?.header.get("Nats-Msg-Id")).toBe("");
    } finally {
      await jsm.streams.delete(name).catch(() => undefined);
    }
  });

  it("gives up after the configured attempts", async () => {
    let calls = 0;
    await expect(
      jsPublish(`nostream.${run}.x`, 1, {
        retry: { attempts: 3, backoff: { initial: 5, max: 5, jitter: 0 }, retryable: (e) => (calls++, isRetriablePublishError(e)) },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("does not retry when the predicate refuses", async () => {
    let calls = 0;
    await expect(
      jsPublish(`nostream.${run}.y`, 1, { retry: { attempts: 5, retryable: () => (calls++, false) } }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("rejects invalid attempts", async () => {
    await expect(jsPublish(`x.${run}`, 1, { retry: { attempts: 0 } })).rejects.toThrow(/attempts/);
  });
});

describe("trace propagation", () => {
  const TRACE = TraceContext.parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "vendor=abc");

  beforeAll(async () => {
    await connectNats({ servers: process.env.NATS_URL, name: "next-nats-trace-test" });
  });

  afterAll(async () => {
    await closeNats();
  });

  async function capture(subject: string, send: () => Promise<unknown>) {
    const { nc } = await getNats();
    const received: Array<ReturnType<typeof headers> | undefined> = [];
    const sub = nc.subscribe(subject, {
      callback: (_e, m) => {
        received.push(m.headers);
        m.respond();
      },
    });
    await send();
    await nc.flush();
    await new Promise((r) => setTimeout(r, 100));
    sub.unsubscribe();
    return received[0];
  }

  it("corePublish sends traceparent and tracestate from a TraceContext", async () => {
    const h = await capture(`trace.${run}.core`, () => corePublish(`trace.${run}.core`, 1, { trace: TRACE }));
    expect(h?.get("traceparent")).toBe(TRACE.traceparent);
    expect(h?.get("tracestate")).toBe("vendor=abc");
  });

  it("request sends the trace", async () => {
    const h = await capture(`trace.${run}.req`, () => request(`trace.${run}.req`, 1, { trace: TRACE }));
    expect(h?.get("traceparent")).toBe(TRACE.traceparent);
  });

  it("keeps the traceparent string option and validates it", async () => {
    const h = await capture(`trace.${run}.str`, () =>
      corePublish(`trace.${run}.str`, 1, { traceparent: TRACE.traceparent, tracestate: "a=b" }),
    );
    expect(h?.get("traceparent")).toBe(TRACE.traceparent);
    expect(h?.get("tracestate")).toBe("a=b");
    await expect(corePublish(`trace.${run}.bad`, 1, { traceparent: "nope" })).rejects.toThrow(/traceparent/);
  });

  it("jsPublish stores the trace headers", async () => {
    const { jsm } = await getNats();
    const name = `TRACE_${run}`;
    await jsm.streams.add({ name, subjects: [`tracejs.${run}`] });
    try {
      const ack = await jsPublish(`tracejs.${run}`, 1, { trace: TRACE });
      const stored = await jsm.streams.getMessage(name, { seq: ack.seq });
      expect(stored?.header.get("traceparent")).toBe(TRACE.traceparent);
      expect(stored?.header.get("tracestate")).toBe("vendor=abc");
    } finally {
      await jsm.streams.delete(name).catch(() => undefined);
    }
  });
});

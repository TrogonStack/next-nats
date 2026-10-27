import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { corePublish, jsPublish } from "../../src/publish.js";
import { consumeEphemeral } from "../../src/realtime/ephemeral.js";

const run = Math.random().toString(36).slice(2, 8);
const STREAM = `EPH_${run}`;
const SUBJ = `eph.${run}`;

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function consumerCount() {
  const { jsm } = await getNats();
  let n = 0;
  for await (const _ of jsm.consumers.list(STREAM)) void _, n++;
  return n;
}

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_URL, name: "next-nats-eph-test" });
  const { jsm } = await getNats();
  await jsm.streams.add({ name: STREAM, subjects: [`${SUBJ}.>`] });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(STREAM).catch(() => undefined);
  await closeNats();
});

describe("consumeEphemeral", () => {
  it("delivers messages until aborted and removes the consumer", async () => {
    const controller = new AbortController();
    const received: string[] = [];
    const done = consumeEphemeral({
      stream: STREAM,
      filterSubjects: [`${SUBJ}.a`],
      signal: controller.signal,
      handler: (msg) => void received.push(msg.subject),
    });
    await waitFor(async () => (await consumerCount()) === 1);
    await jsPublish(`${SUBJ}.a`, 1);
    await jsPublish(`${SUBJ}.b`, 2);
    await waitFor(() => received.length === 1);
    controller.abort();
    expect(await done).toBe("aborted");
    expect(received).toEqual([`${SUBJ}.a`]);
    await waitFor(async () => (await consumerCount()) === 0);
  });

  it("stops on timeout", async () => {
    const started = Date.now();
    const outcome = await consumeEphemeral({ stream: STREAM, timeoutMs: 300, handler: () => {} });
    expect(outcome).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3_000);
    await waitFor(async () => (await consumerCount()) === 0);
  });

  it("returns immediately when already aborted, without creating a consumer", async () => {
    expect(await consumeEphemeral({ stream: STREAM, signal: AbortSignal.abort(), handler: () => {} })).toBe("aborted");
    expect(await consumerCount()).toBe(0);
  });

  it("isolates handler errors per message", async () => {
    const received: number[] = [];
    const errors: unknown[] = [];
    const controller = new AbortController();
    const done = consumeEphemeral({
      stream: STREAM,
      filterSubjects: [`${SUBJ}.err`],
      deliver: "all",
      signal: controller.signal,
      handler: (msg) => {
        const n = msg.json<number>();
        if (n === 2) throw new Error("bad message");
        received.push(n);
      },
      onError: (error) => void errors.push(error),
    });
    for (const n of [1, 2, 3]) await jsPublish(`${SUBJ}.err`, n);
    await waitFor(() => received.length === 2);
    controller.abort();
    await done;
    expect(received).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
  });

  it("delivers from the beginning with deliver all", async () => {
    await jsPublish(`${SUBJ}.old`, "x");
    const received: string[] = [];
    await consumeEphemeral({
      stream: STREAM,
      filterSubjects: [`${SUBJ}.old`],
      deliver: "all",
      timeoutMs: 800,
      handler: (msg) => void received.push(msg.string()),
    });
    expect(received).toEqual(["x"]);
  });

  it("cleans up when the handler hook itself throws and when the stream is missing", async () => {
    await expect(consumeEphemeral({ stream: `MISSING_${run}`, timeoutMs: 200, handler: () => {} })).rejects.toThrow();
    const outcome = await consumeEphemeral({
      stream: STREAM,
      timeoutMs: 300,
      deliver: "all",
      handler: () => {
        throw new Error("x");
      },
      onError: () => {
        throw new Error("hook");
      },
    });
    expect(outcome).toBe("timeout");
    await waitFor(async () => (await consumerCount()) === 0);
    await corePublish(`${SUBJ}.none`, 1);
  });
});

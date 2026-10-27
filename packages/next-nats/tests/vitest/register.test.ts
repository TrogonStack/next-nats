import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import { stopAllConsumers } from "../../src/consumer.js";
import { stopAllDeadLetterConsumers, deadLetterCaptureSpec } from "../../src/dead-letter.js";
import { registerNats } from "../../src/instrumentation.js";
import { jsPublish } from "../../src/publish.js";
import { defineStream } from "../../src/streams.js";

const run = Math.random().toString(36).slice(2, 8);
const STREAM = `REG_${run}`;
const MISSING = `REGMISSING_${run}`;
const CAPTURE = `REGCAP_${run}`;

async function waitFor(fn: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_URL, workers: true, name: "next-nats-register-test" });
});

afterAll(async () => {
  await stopAllDeadLetterConsumers();
  await stopAllConsumers();
  const { jsm } = await getNats();
  for (const n of [STREAM, CAPTURE]) await jsm.streams.delete(n).catch(() => undefined);
  await closeNats();
});

describe("declarative registerNats", () => {
  it("provisions streams first, then starts consumers and dead letter consumers, reporting errors", async () => {
    const received: unknown[] = [];
    const deadLetters: unknown[] = [];
    const errors: unknown[] = [];

    await registerNats({
      streams: [
        defineStream({ name: STREAM, subjects: [`reg.${run}.>`], maxAge: "1h" }),
        defineStream(deadLetterCaptureSpec({ name: CAPTURE, streams: [STREAM] }), { provision: "update" }),
        defineStream({ name: MISSING }, { provision: "never" }),
      ],
      consumers: [
        {
          stream: STREAM,
          durable: `reg_${run}`,
          filterSubjects: [`reg.${run}.ok`],
          handler: (payload) => void received.push(payload),
        },
        {
          stream: STREAM,
          durable: `regbad_${run}`,
          filterSubjects: [`reg.${run}.bad`],
          maxDeliver: 1,
          handler: () => {
            throw new Error("poison");
          },
        },
      ],
      deadLetterConsumers: [
        {
          stream: STREAM,
          durable: `regdl_${run}`,
          capture: CAPTURE,
          handler: (event) => void deadLetters.push(event),
        },
      ],
      onError: (e) => errors.push(e),
    });

    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toContain(MISSING);

    await jsPublish(`reg.${run}.ok`, { hello: "world" });
    await jsPublish(`reg.${run}.bad`, { bad: true });
    await waitFor(() => received.length === 1 && deadLetters.length >= 1);
    expect(received).toEqual([{ hello: "world" }]);
    expect(deadLetters[0]).toMatchObject({ kind: "terminated", stream: STREAM, consumer: `regbad_${run}` });
  });
});

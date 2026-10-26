import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as real from "@vercel/queue";
import { closeNats, connectNats, getNats } from "../../../src/connection.js";
import * as ours from "../../../src/queue/index.js";
import { FakeVercelQueue } from "../../support/fakes/vercel-queue.js";

const run = Math.random().toString(36).slice(2, 8);
const nats = { stream: `QD_${run}`, prefix: `qd${run}` };
const fake = new FakeVercelQueue();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;
const topicName = (label: string) => `${label}-${run}-${counter++}`;

async function waitFor(fn: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await sleep(15);
  }
}

type Metadata = real.MessageMetadata;
type Handler = (payload: unknown, metadata: Metadata) => void | Promise<void>;
type ReceiveOptions = Parameters<real.PollingQueueClient["receive"]>[3];

interface Api {
  send: real.PollingQueueClient["send"];
  sendBatch: real.PollingQueueClient["sendBatch"];
  receive: real.PollingQueueClient["receive"];
  push: real.QueueClient;
}

function realApi(options: Record<string, unknown> = {}): Api {
  const common = { ...fake.clientOptions(), ...options };
  const poll = new real.PollingQueueClient(common as never);
  return { send: poll.send, sendBatch: poll.sendBatch, receive: poll.receive, push: new real.QueueClient(common as never) };
}

function oursApi(options: Record<string, unknown> = {}): Api {
  const common = { region: "iad1", nats, ...options };
  const poll = new ours.PollingQueueClient(common as never);
  return {
    send: poll.send as Api["send"],
    sendBatch: poll.sendBatch as Api["sendBatch"],
    receive: poll.receive as Api["receive"],
    push: new ours.QueueClient(common as never) as unknown as real.QueueClient,
  };
}

interface Seen {
  payload: unknown;
  deliveryCount: number;
  topicName: string;
  consumerGroup: string;
  region: string;
  lifetimeMs: number;
  createdRecent: boolean;
}

function observe(seen: Seen[]): Handler {
  return (payload, metadata) => {
    seen.push({
      payload,
      deliveryCount: metadata.deliveryCount,
      topicName: metadata.topicName,
      consumerGroup: metadata.consumerGroup,
      region: metadata.region,
      lifetimeMs: Math.round((metadata.expiresAt.getTime() - metadata.createdAt.getTime()) / 1000) * 1000,
      createdRecent: Math.abs(Date.now() - metadata.createdAt.getTime()) < 5_000,
    });
  };
}

async function failure(call: () => Promise<unknown>): Promise<{ name: string; message: string } | "resolved"> {
  try {
    await call();
    return "resolved";
  } catch (error) {
    return { name: (error as Error).name, message: (error as Error).message };
  }
}

async function both<T>(scenario: (api: Api, name: "real" | "ours") => Promise<T>): Promise<{ real: T; ours: T }> {
  const [realResult, oursResult] = await Promise.all([scenario(realApi(), "real"), scenario(oursApi(), "ours")]);
  return { real: realResult, ours: oursResult };
}

beforeAll(async () => {
  await fake.start();
  await connectNats({ servers: process.env.NATS_SERVERS, name: "next-nats-queue-differential", workers: true });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(nats.stream).catch(() => undefined);
  await closeNats();
  await fake.stop();
});

describe("differential: poll mode", () => {
  it("round trips a JSON payload with the same metadata and then reports empty", async () => {
    const result = await both(async (api) => {
      const topic = topicName("rt");
      const seen: Seen[] = [];
      const sent = await api.send(topic, { hello: "world", n: [1, 2, 3] });
      const first = await api.receive(topic, "g", observe(seen));
      const second = await api.receive(topic, "g", observe(seen));
      return { sentIsString: typeof sent.messageId, first, second, seen: seen.map((s) => ({ ...s, topicName: s.topicName.replace(/-.*/, "") })) };
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real.first).toEqual({ ok: true });
    expect(result.real.second).toEqual({ ok: false, reason: "empty" });
    expect(result.real.seen[0]).toMatchObject({ payload: { hello: "world", n: [1, 2, 3] }, deliveryCount: 1, region: "iad1", lifetimeMs: 86_400_000, createdRecent: true });
  });

  it("applies retentionSeconds to expiresAt", async () => {
    const result = await both(async (api) => {
      const topic = topicName("ret");
      const seen: Seen[] = [];
      await api.send(topic, "x", { retentionSeconds: 120 });
      await api.receive(topic, "g", observe(seen));
      return seen.map((s) => s.lifetimeMs);
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real).toEqual([120_000]);
  });

  it("delivers a batch in publish order up to the limit", async () => {
    const result = await both(async (api) => {
      const topic = topicName("lim");
      for (const n of [1, 2, 3, 4]) await api.send(topic, { n });
      const seen: Seen[] = [];
      const first = await api.receive(topic, "g", observe(seen), { limit: 3 });
      const second = await api.receive(topic, "g", observe(seen));
      return { first, second, order: seen.map((s) => s.payload) };
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real.order).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  });

  it("fans out to every consumer group and lets a new group read from the beginning", async () => {
    const result = await both(async (api) => {
      const topic = topicName("fan");
      await api.send(topic, "before");
      const a: Seen[] = [];
      const b: Seen[] = [];
      await api.receive(topic, "a", observe(a));
      await api.send(topic, "after");
      await api.receive(topic, "b", observe(b), { limit: 2 });
      await api.receive(topic, "a", observe(a));
      return { a: a.map((s) => s.payload), b: b.map((s) => s.payload), group: a[0]!.consumerGroup };
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real.a).toEqual(["before", "after"]);
    expect(result.real.b).toEqual(["before", "after"]);
  });

  it("holds a delayed message until it is visible", async () => {
    const result = await both(async (api) => {
      const topic = topicName("delay");
      const seen: Seen[] = [];
      await api.send(topic, "later", { delaySeconds: 2 });
      const early = await api.receive(topic, "g", observe(seen));
      await sleep(2_300);
      const late = await api.receive(topic, "g", observe(seen));
      return { early, late, payloads: seen.map((s) => s.payload) };
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real).toEqual({ early: { ok: false, reason: "empty" }, late: { ok: true }, payloads: ["later"] });
  });

  it("accepts a delay beyond retention and never delivers the message", async () => {
    const result = await both(async (api) => {
      const topic = topicName("delayttl");
      const seen: Seen[] = [];
      const sent = await failure(() => api.send(topic, "never", { retentionSeconds: 60, delaySeconds: 120 }));
      const received = await api.receive(topic, "g", observe(seen));
      return { sent, received, seen: seen.length };
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real).toEqual({ sent: "resolved", received: { ok: false, reason: "empty" }, seen: 0 });
  });

  it("deduplicates repeated sends with the same idempotency key without failing", async () => {
    const result = await both(async (api) => {
      const topic = topicName("idem");
      const first = await failure(() => api.send(topic, "once", { idempotencyKey: "k1" }));
      const second = await failure(() => api.send(topic, "once", { idempotencyKey: "k1" }));
      const seen: Seen[] = [];
      await api.receive(topic, "g", observe(seen), { limit: 5 });
      const rest = await api.receive(topic, "g", observe(seen));
      return { first, second, delivered: seen.length, rest };
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real).toEqual({ first: "resolved", second: "resolved", delivered: 1, rest: { ok: false, reason: "empty" } });
  });

  it("rethrows a handler error, keeps the message leased, and does not redeliver it immediately", async () => {
    const result = await both(async (api) => {
      const topic = topicName("throw");
      await api.send(topic, "boom");
      const error = await failure(() =>
        api.receive(topic, "g", () => {
          throw new TypeError("handler exploded");
        }),
      );
      const after = await api.receive(topic, "g", () => undefined);
      return { error, after };
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real).toEqual({ error: { name: "TypeError", message: "handler exploded" }, after: { ok: false, reason: "empty" } });
  });

  it("swallows the error and redelivers with a higher delivery count after an afterSeconds directive", async () => {
    const result = await both(async (api) => {
      const topic = topicName("retry");
      const seen: Seen[] = [];
      const directives: number[] = [];
      await api.send(topic, "again");
      const startedAt = Date.now();
      const first = await api.receive(
        topic,
        "g",
        (payload, metadata) => {
          observe(seen)(payload, metadata);
          throw new Error("try later");
        },
        {
          retry: (_error, metadata) => {
            directives.push(metadata.deliveryCount);
            return { afterSeconds: 2 };
          },
        } as ReceiveOptions,
      );
      const immediate = await api.receive(topic, "g", observe(seen));
      await sleep(Math.max(0, 2_400 - (Date.now() - startedAt)));
      const second = await api.receive(topic, "g", observe(seen));
      return { first, immediate, second, counts: seen.map((s) => s.deliveryCount), directives };
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real).toEqual({ first: { ok: true }, immediate: { ok: false, reason: "empty" }, second: { ok: true }, counts: [1, 2], directives: [1] });
  });

  it("acknowledges a failing message when the retry directive says so", async () => {
    const result = await both(async (api) => {
      const topic = topicName("ackdir");
      await api.send(topic, "poison");
      const first = await api.receive(
        topic,
        "g",
        () => {
          throw new Error("bad");
        },
        { retry: () => ({ acknowledge: true }) } as ReceiveOptions,
      );
      await sleep(300);
      const second = await api.receive(topic, "g", () => undefined);
      return { first, second };
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real).toEqual({ first: { ok: true }, second: { ok: false, reason: "empty" } });
  });

  it("round trips binary payloads through BufferTransport", async () => {
    const result = await both(async (_api, name) => {
      const common = { transport: new real.BufferTransport() };
      const client =
        name === "real"
          ? new real.PollingQueueClient({ ...fake.clientOptions(), ...common } as never)
          : (new ours.PollingQueueClient({ region: "iad1", nats, transport: new ours.BufferTransport() } as never) as unknown as real.PollingQueueClient);
      const topic = topicName("buf");
      await client.send(topic, Buffer.from([0, 1, 2, 255]) as never);
      const got: number[][] = [];
      await client.receive(topic, "g", ((payload: Buffer) => {
        got.push([...payload]);
      }) as Handler);
      return got;
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real).toEqual([[0, 1, 2, 255]]);
  });

  it("reports the same batch result shapes and per-message failures", async () => {
    const result = await both(async (api) => {
      const topic = topicName("batch");
      const results = await api.sendBatch(topic, [{ payload: 1 }, { payload: 2, retentionSeconds: 5 }, { payload: 3, idempotencyKey: "b3" }]);
      const seen: Seen[] = [];
      await api.receive(topic, "g", observe(seen), { limit: 10 });
      return {
        shapes: results.map((r) => (r.status === "failed" ? { status: r.status, statusCode: r.statusCode, retryable: r.retryable } : { status: r.status, id: typeof r.messageId })),
        delivered: seen.map((s) => s.payload),
      };
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real.shapes).toEqual([
      { status: "sent", id: "string" },
      { status: "failed", statusCode: 400, retryable: false },
      { status: "sent", id: "string" },
    ]);
    expect(result.real.delivered).toEqual([1, 3]);
  });

  it("validates arguments with the same error classes and messages", async () => {
    const result = await both(async (api) => {
      const topic = topicName("val");
      return {
        zeroLimit: await failure(() => api.receive(topic, "g", () => undefined, { limit: 0 } as ReceiveOptions)),
        bigLimit: await failure(() => api.receive(topic, "g", () => undefined, { limit: 11 } as ReceiveOptions)),
        emptyBatch: await failure(() => api.sendBatch(topic, [])),
        bigBatch: await failure(() => api.sendBatch(topic, Array.from({ length: 101 }, (_, n) => ({ payload: n })))),
      };
    });
    expect(result.ours).toEqual(result.real);
  });

  it("rejects out of range send options with a BadRequestError", async () => {
    const result = await both(async (api) => {
      const topic = topicName("opts");
      const classOf = async (options: Parameters<Api["send"]>[2]) => {
        const outcome = await failure(() => api.send(topic, "x", options));
        return outcome === "resolved" ? outcome : outcome.name;
      };
      return {
        shortRetention: await classOf({ retentionSeconds: 59 }),
        longRetention: await classOf({ retentionSeconds: 604_801 }),
        longDelay: await classOf({ delaySeconds: 604_801 }),
        longKey: await classOf({ idempotencyKey: "k".repeat(257) }),
        okKey: await classOf({ idempotencyKey: "k".repeat(256) }),
      };
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real).toEqual({ shortRetention: "BadRequestError", longRetention: "BadRequestError", longDelay: "BadRequestError", longKey: "BadRequestError", okKey: "resolved" });
  });

  it("rejects invalid topic names with a BadRequestError", async () => {
    const result = await both(async (api) => {
      const outcome = await failure(() => api.send("bad topic!", "x"));
      return outcome === "resolved" ? outcome : outcome.name;
    });
    expect(result.ours).toEqual(result.real);
    expect(result.real).toBe("BadRequestError");
  });

  it("rejects invalid region codes with the same message", async () => {
    const realError = await failure(async () => new real.PollingQueueClient({ ...fake.clientOptions(), region: "BAD" } as never).send("t", 1));
    const oursError = await failure(async () => new ours.PollingQueueClient({ region: "BAD", nats } as never).send("t", 1));
    expect(oursError).toEqual(realError);
  });

  it("reports ReceiveByMessageId for an unknown message as not_found like the real client", async () => {
    const realResult = await realApi().receive(topicName("byid"), "g", () => undefined, { messageId: "msg_missing" } as ReceiveOptions);
    expect(realResult).toEqual({ ok: false, reason: "not_found", messageId: "msg_missing" });
  });

  it.fails("supports receiving by message id (the real client resolves unknown ids to not_found)", async () => {
    const result = await oursApi().receive(topicName("byid"), "g", () => undefined, { messageId: "msg_missing" } as ReceiveOptions);
    expect(result).toEqual({ ok: false, reason: "not_found", messageId: "msg_missing" });
  });

  it("sends the documented wire format", async () => {
    fake.requests.length = 0;
    const api = realApi();
    const topic = topicName("wire");
    await api.send(topic, { a: 1 }, { idempotencyKey: "w1", retentionSeconds: 90, delaySeconds: 0, headers: { "x-custom": "v" } });
    const request = fake.requests.find((r) => r.method === "POST" && r.path === `/api/v3/topic/${topic}`)!;
    expect(request.headers["user-agent"]).toBe("@vercel/queue/0.10.0");
    expect(request.headers.authorization).toBe(`Bearer ${fake.token}`);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["vqs-idempotency-key"]).toBe("w1");
    expect(request.headers["vqs-retention-seconds"]).toBe("90");
    expect(request.headers["vqs-delay-seconds"]).toBe("0");
    expect(request.headers["x-custom"]).toBe("v");
    expect(request.headers["vqs-client-ts"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(request.body.toString()).toBe('{"a":1}');
  });
});

describe("differential: push mode callbacks", () => {
  interface Route {
    url: string;
    close(): Promise<void>;
  }

  async function serve(handler: (request: Request) => Promise<Response>): Promise<Route> {
    const server: Server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const response = await handler(new Request(`http://localhost${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }));
      res.statusCode = response.status;
      res.end(await response.text());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  interface PushOutcome {
    handler: Seen[];
    dispatches: Array<{ status: number; body: string; deliveryCount: number }>;
    ceHeaders: string[];
  }

  interface PushScenario {
    handler: (seen: Seen[]) => Handler;
    options?: (calls: number[]) => Record<string, unknown>;
    trigger?: { retryAfterSeconds?: number; initialDelaySeconds?: number; maxDeliveries?: number };
    settle(state: { seen: Seen[]; dispatches: PushOutcome["dispatches"] }): boolean;
    send?: Parameters<Api["send"]>[2];
    quietMs?: number;
  }

  async function push(name: "real" | "ours", scenario: PushScenario): Promise<PushOutcome> {
    const topic = topicName("push");
    const file = "app/api/queues/work/route.ts";
    const group = ours.filePathToConsumerGroup(file);
    const seen: Seen[] = [];
    const dispatches: PushOutcome["dispatches"] = [];
    const ceHeaders = new Set<string>();
    const api = name === "real" ? realApi() : oursApi();
    const route = await serve(api.push.handleCallback(scenario.handler(seen), scenario.options?.([]) as never) as never);
    let stop: () => Promise<void>;
    if (name === "real") {
      fake.addTrigger({ topic, consumerGroup: group, url: `${route.url}/api/queues/work`, ...scenario.trigger });
      stop = async () => undefined;
    } else {
      const doFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        const text = await response.clone().text();
        const headers = new Headers(init?.headers);
        dispatches.push({ status: response.status, body: text, deliveryCount: Number(headers.get("ce-vqsdeliverycount")) });
        headers.forEach((_, key) => { if (key.startsWith("ce-vqs")) ceHeaders.add(key); });
        return response;
      };
      const worker = ours.startQueueWorker({
        vercelJson: { functions: { [file]: { experimentalTriggers: [{ type: "queue/v2beta", topic, ...scenario.trigger }] } } },
        baseUrl: route.url,
        nats,
        fetch: doFetch,
      });
      stop = () => worker.stop();
    }
    const startedAt = fake.dispatches.length;
    await api.send(topic, { job: name }, scenario.send);
    const view = () => {
      if (name === "real") {
        dispatches.length = 0;
        for (const d of fake.dispatches.slice(startedAt).filter((d) => d.requestHeaders["ce-vqsqueuename"] === topic)) {
          dispatches.push({ status: d.status, body: d.responseBody, deliveryCount: d.deliveryCount });
          for (const key of Object.keys(d.requestHeaders)) if (key.startsWith("ce-vqs")) ceHeaders.add(key);
        }
      }
      return { seen, dispatches };
    };
    await waitFor(() => scenario.settle(view()), 15_000);
    await sleep(scenario.quietMs ?? 600);
    view();
    await stop();
    await route.close();
    fake.reset();
    return { handler: seen.map((s) => ({ ...s, topicName: "t", consumerGroup: s.consumerGroup === group ? "group" : s.consumerGroup, createdRecent: s.createdRecent })), dispatches, ceHeaders: [...ceHeaders].sort() };
  }

  const bothPush = async (scenario: PushScenario) => {
    const realOutcome = await push("real", scenario);
    const oursOutcome = await push("ours", scenario);
    return { real: realOutcome, ours: oursOutcome };
  };

  it("acknowledges a successful handler and reports success", async () => {
    const result = await bothPush({
      handler: (seen) => observe(seen),
      settle: ({ dispatches }) => dispatches.length >= 1,
    });
    expect(result.ours.dispatches).toEqual(result.real.dispatches.map((d) => ({ ...d, body: d.body })));
    expect(result.real.dispatches).toEqual([{ status: 200, body: '{"status":"success"}', deliveryCount: 1 }]);
    expect(result.ours.handler.map((h) => ({ ...h, payload: undefined }))).toEqual(result.real.handler.map((h) => ({ ...h, payload: undefined })));
    expect(result.real.handler[0]).toMatchObject({ deliveryCount: 1, region: "iad1", lifetimeMs: 86_400_000, consumerGroup: "group" });
    expect(result.ours.ceHeaders).toEqual(result.real.ceHeaders);
  });

  it("answers 500 for a throwing handler and redelivers after retryAfterSeconds", async () => {
    const result = await bothPush({
      handler: (seen) => (payload, metadata) => {
        observe(seen)(payload, metadata);
        if (metadata.deliveryCount === 1) throw new Error("first attempt fails");
      },
      trigger: { retryAfterSeconds: 1 },
      settle: ({ dispatches }) => dispatches.length >= 2,
    });
    expect(result.ours.dispatches).toEqual(result.real.dispatches);
    expect(result.real.dispatches).toEqual([
      { status: 500, body: '{"error":"Failed to process queue message"}', deliveryCount: 1 },
      { status: 200, body: '{"status":"success"}', deliveryCount: 2 },
    ]);
  });

  it("honors an afterSeconds retry directive without failing the callback", async () => {
    const result = await bothPush({
      handler: (seen) => (payload, metadata) => {
        observe(seen)(payload, metadata);
        if (metadata.deliveryCount === 1) throw new Error("later");
      },
      options: () => ({ retry: () => ({ afterSeconds: 1 }) }),
      settle: ({ dispatches }) => dispatches.length >= 2,
    });
    expect(result.ours.dispatches).toEqual(result.real.dispatches);
    expect(result.real.dispatches.map((d) => d.status)).toEqual([200, 200]);
    expect(result.real.handler.map((h) => h.deliveryCount)).toEqual([1, 2]);
  });

  it("stops redelivering when the retry directive acknowledges", async () => {
    const result = await bothPush({
      handler: () => () => {
        throw new Error("poison");
      },
      options: () => ({ retry: () => ({ acknowledge: true }) }),
      trigger: { retryAfterSeconds: 1 },
      settle: ({ dispatches }) => dispatches.length >= 1,
      quietMs: 1_800,
    });
    expect(result.ours.dispatches).toEqual(result.real.dispatches);
    expect(result.real.dispatches).toEqual([{ status: 200, body: '{"status":"success"}', deliveryCount: 1 }]);
  });

  it("waits initialDelaySeconds before the first delivery", async () => {
    const started = Date.now();
    const result = await bothPush({
      handler: (seen) => observe(seen),
      trigger: { initialDelaySeconds: 1 },
      settle: ({ dispatches }) => dispatches.length >= 1,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    expect(result.ours.dispatches).toEqual(result.real.dispatches);
  });

  it("stops retrying after maxDeliveries", async () => {
    const result = await bothPush({
      handler: () => () => {
        throw new Error("always");
      },
      trigger: { retryAfterSeconds: 1, maxDeliveries: 2 },
      settle: ({ dispatches }) => dispatches.length >= 2,
      quietMs: 2_500,
    });
    expect(result.real.dispatches.map((d) => d.status)).toEqual([500, 500]);
    expect(result.ours.dispatches).toEqual(result.real.dispatches);
  });

  it("answers malformed callbacks with the same status and body", async () => {
    const cases: Array<{ headers: Record<string, string>; body: string }> = [
      { headers: { "content-type": "application/json" }, body: "{}" },
      { headers: { "content-type": "application/cloudevents+json" }, body: "not json" },
      { headers: { "content-type": "application/cloudevents+json" }, body: '{"type":"x"}' },
      { headers: { "content-type": "application/cloudevents+json" }, body: JSON.stringify({ type: "wrong", source: "s", id: "i", data: { queueName: "q", consumerGroup: "g", messageId: "m" } }) },
      { headers: { "ce-type": "com.vercel.queue.v2beta", "content-type": "application/json" }, body: "{}" },
      { headers: { "ce-type": "com.vercel.queue.v2beta", "ce-vqsqueuename": "q", "ce-vqsconsumergroup": "g", "ce-vqsmessageid": "m", "ce-vqsregion": "BAD" }, body: "" },
    ];
    const outcomes = async (api: Api) => {
      const handler = api.push.handleCallback(() => undefined);
      const out: Array<{ status: number; body: unknown }> = [];
      for (const c of cases) {
        const response = await handler(new Request("http://localhost/api/queues/work", { method: "POST", headers: c.headers, body: c.body }));
        out.push({ status: response.status, body: await response.json() });
      }
      return out;
    };
    const realOutcome = await outcomes(realApi());
    const oursOutcome = await outcomes(oursApi());
    expect(oursOutcome).toEqual(realOutcome);
    expect(realOutcome.map((o) => o.status)).toEqual([400, 400, 400, 400, 400, 500]);
  });
});

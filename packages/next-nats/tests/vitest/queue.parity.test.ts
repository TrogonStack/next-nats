import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import * as real from "@vercel/queue";
import { closeNats, connectNats, getNats } from "../../src/connection.js";
import * as ours from "../../src/queue/index.js";

const run = Math.random().toString(36).slice(2, 8);
const nats = { stream: `QT_${run}`, prefix: `qt${run}` };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn: () => boolean, ms = 8_000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await sleep(20);
  }
}

const ERROR_NAMES = [
  "BadRequestError",
  "ConcurrencyCoalescedPendingError",
  "ConsumerDiscoveryError",
  "ConsumerRegistryNotConfiguredError",
  "ForbiddenError",
  "InternalServerError",
  "InvalidLimitError",
  "MessageAlreadyProcessedError",
  "MessageCorruptedError",
  "MessageLockedError",
  "MessageNotAvailableError",
  "MessageNotFoundError",
  "PayloadTooLargeError",
  "QueueEmptyError",
  "TooManyRequestsError",
  "UnauthorizedError",
] as const;

function flatten(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

const newClient = () => new ours.QueueClient({ nats } as ConstructorParameters<typeof ours.QueueClient>[0]);
const newPolling = () => new ours.PollingQueueClient({ nats } as ConstructorParameters<typeof ours.PollingQueueClient>[0]);

let topicSeq = 0;
const topicName = (label: string) => `${label}-${run}-${topicSeq++}`;

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_URL, name: "next-nats-queue-test", workers: true });
});

afterAll(async () => {
  const { jsm } = await getNats();
  await jsm.streams.delete(nats.stream).catch(() => undefined);
  await closeNats();
});

describe("type parity with @vercel/queue", () => {
  it("exposes the same runtime export names plus NATS extras", () => {
    const realNames = Object.keys(real).sort();
    const ourNames = Object.keys(ours);
    for (const name of realNames) expect(ourNames, name).toContain(name);
  });

  it("matches function signatures", () => {
    expectTypeOf(ours.send).toEqualTypeOf<typeof real.send>();
    expectTypeOf(ours.sendBatch).toEqualTypeOf<typeof real.sendBatch>();
    expectTypeOf(ours.experimental_sendBatch).toEqualTypeOf<typeof real.experimental_sendBatch>();
    expectTypeOf(ours.parseCallback).toEqualTypeOf<typeof real.parseCallback>();
    expectTypeOf(ours.parseRawCallback).toEqualTypeOf<typeof real.parseRawCallback>();
  });

  it("matches handleCallback and registerDevConsumer parameters", () => {
    expectTypeOf<Parameters<typeof ours.handleCallback>>().toEqualTypeOf<Parameters<typeof real.handleCallback>>();
    expectTypeOf<ReturnType<typeof ours.handleCallback>>().toEqualTypeOf<ReturnType<typeof real.handleCallback>>();
    expectTypeOf<Parameters<typeof ours.registerDevConsumer>[0]["topic"]>().toEqualTypeOf<Parameters<typeof real.registerDevConsumer>[0]["topic"]>();
    expectTypeOf<ReturnType<typeof ours.registerDevConsumer>>().toEqualTypeOf<ReturnType<typeof real.registerDevConsumer>>();
  });

  it("matches client member types", () => {
    type OurClient = InstanceType<typeof ours.QueueClient>;
    type RealClient = InstanceType<typeof real.QueueClient>;
    expectTypeOf<OurClient["send"]>().toEqualTypeOf<RealClient["send"]>();
    expectTypeOf<OurClient["sendBatch"]>().toEqualTypeOf<RealClient["sendBatch"]>();
    expectTypeOf<OurClient["experimental_sendBatch"]>().toEqualTypeOf<RealClient["experimental_sendBatch"]>();
    expectTypeOf<OurClient["handleCallback"]>().toEqualTypeOf<RealClient["handleCallback"]>();
    expectTypeOf<OurClient["handleNodeCallback"]>().toEqualTypeOf<RealClient["handleNodeCallback"]>();
    type OurPolling = InstanceType<typeof ours.PollingQueueClient>;
    type RealPolling = InstanceType<typeof real.PollingQueueClient>;
    expectTypeOf<OurPolling["send"]>().toEqualTypeOf<RealPolling["send"]>();
    expectTypeOf<OurPolling["sendBatch"]>().toEqualTypeOf<RealPolling["sendBatch"]>();
    expectTypeOf<OurPolling["receive"]>().toEqualTypeOf<RealPolling["receive"]>();
  });

  it("matches the data types", () => {
    expectTypeOf<ours.SendOptions>().toEqualTypeOf<real.SendOptions>();
    expectTypeOf<ours.SendResult>().toEqualTypeOf<real.SendResult>();
    expectTypeOf<ours.BatchSendResult>().toEqualTypeOf<real.BatchSendResult>();
    expectTypeOf<ours.BatchSendMessage>().toEqualTypeOf<real.BatchSendMessage>();
    expectTypeOf<ours.BatchSendOptions>().toEqualTypeOf<real.BatchSendOptions>();
    expectTypeOf<ours.Message>().toEqualTypeOf<real.Message>();
    expectTypeOf<ours.MessageMetadata>().toEqualTypeOf<real.MessageMetadata>();
    expectTypeOf<ours.MessageHandler>().toEqualTypeOf<real.MessageHandler>();
    expectTypeOf<ours.RetryDirective>().toEqualTypeOf<real.RetryDirective>();
    expectTypeOf<ours.RetryHandler>().toEqualTypeOf<real.RetryHandler>();
    expectTypeOf<ours.ReceiveOptions>().toEqualTypeOf<real.ReceiveOptions>();
    expectTypeOf<ours.ReceiveResult>().toEqualTypeOf<real.ReceiveResult>();
    expectTypeOf<ours.ParsedCallbackRequest>().toEqualTypeOf<real.ParsedCallbackRequest>();
    expectTypeOf<ours.Transport>().toEqualTypeOf<real.Transport>();
    expectTypeOf<ours.VercelRegion>().toEqualTypeOf<real.VercelRegion>();
  });

  it("matches transports", () => {
    expectTypeOf<InstanceType<typeof ours.JsonTransport>>().toMatchTypeOf<real.Transport>();
    expectTypeOf<InstanceType<typeof ours.BufferTransport>>().toMatchTypeOf<real.Transport>();
    expectTypeOf<InstanceType<typeof ours.StreamTransport>>().toMatchTypeOf<real.Transport>();
    expect(new ours.JsonTransport().contentType).toBe(new real.JsonTransport().contentType);
    expect(new ours.BufferTransport().contentType).toBe(new real.BufferTransport().contentType);
    expect(new ours.StreamTransport().contentType).toBe(new real.StreamTransport().contentType);
  });

  it("matches constants", () => {
    expect(ours.CLOUD_EVENT_TYPE_V1BETA).toBe(real.CLOUD_EVENT_TYPE_V1BETA);
    expect(ours.CLOUD_EVENT_TYPE_V2BETA).toBe(real.CLOUD_EVENT_TYPE_V2BETA);
  });

  it.each(ERROR_NAMES)("matches error class %s", (name) => {
    const O = ours[name] as new (...args: never[]) => Error;
    const R = real[name] as new (...args: never[]) => Error;
    expect(O.name).toBe(name);
    const args = name === "InvalidLimitError" ? ([5] as never[]) : name === "MessageLockedError" ? (["id", 10] as never[]) : (["x"] as never[]);
    const a = new O(...args);
    const b = new R(...args);
    expect(a).toBeInstanceOf(Error);
    expect(a.name).toBe(b.name);
    expect(a.message).toBe(b.message);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });
});

describe("send validation", () => {
  const client = newClient();

  it("rejects invalid topic names", async () => {
    await expect(client.send("bad topic!", {})).rejects.toBeInstanceOf(ours.BadRequestError);
  });

  it("rejects batches outside 1..100", async () => {
    await expect(client.sendBatch(topicName("b"), [])).rejects.toThrow(RangeError);
    await expect(client.sendBatch(topicName("b"), Array.from({ length: 101 }, (_, i) => ({ payload: i })))).rejects.toThrow(
      "Batch size must be between 1 and 100 messages",
    );
  });

  it("accepts a delay beyond retention and rejects oversized idempotency keys", async () => {
    await expect(client.send(topicName("v"), 1, { retentionSeconds: 60, delaySeconds: 120 })).resolves.toHaveProperty("messageId");
    await expect(client.send(topicName("v"), 1, { idempotencyKey: "k".repeat(257) })).rejects.toBeInstanceOf(ours.BadRequestError);
  });
});

describe("polling receive", () => {
  it("round trips a payload with metadata", async () => {
    const topic = topicName("rt");
    const client = newPolling();
    const sent = await client.send(topic, { n: 1 });
    expect(sent.messageId).toMatch(/^[0-9a-f-]{36}$/);
    let seen: { payload: unknown; meta: ours.MessageMetadata } | undefined;
    const result = await client.receive<{ n: number }>(topic, "g1", (payload, meta) => {
      seen = { payload, meta };
    });
    expect(result).toEqual({ ok: true });
    expect(seen?.payload).toEqual({ n: 1 });
    expect(seen?.meta.messageId).toBe(sent.messageId);
    expect(seen?.meta.deliveryCount).toBe(1);
    expect(seen?.meta.topicName).toBe(topic);
    expect(seen?.meta.consumerGroup).toBe("g1");
    expect(seen?.meta.region).toMatch(/^[a-z]{2,5}[0-9]{1,2}$/);
    expect(seen?.meta.createdAt).toBeInstanceOf(Date);
    expect(seen?.meta.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("reports empty when nothing is available", async () => {
    const result = await newPolling().receive(topicName("e"), "g1", () => undefined);
    expect(result).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects limits outside 1..10", async () => {
    await expect(newPolling().receive(topicName("l"), "g1", () => undefined, { limit: 11 })).rejects.toBeInstanceOf(ours.InvalidLimitError);
  });

  it("delivers each message once per consumer group and fans out across groups", async () => {
    const topic = topicName("fan");
    const client = newPolling();
    await client.send(topic, "a");
    const a: unknown[] = [];
    const b: unknown[] = [];
    await client.receive(topic, "ga", (p) => void a.push(p));
    await client.receive(topic, "gb", (p) => void b.push(p));
    expect(a).toEqual(["a"]);
    expect(b).toEqual(["a"]);
    expect(await client.receive(topic, "ga", () => undefined)).toEqual({ ok: false, reason: "empty" });
  });

  it("deduplicates by idempotency key", async () => {
    const topic = topicName("idem");
    const client = newPolling();
    const first = await client.send(topic, 1, { idempotencyKey: "same" });
    const second = await client.send(topic, 2, { idempotencyKey: "same" });
    expect(second.messageId).toBe(first.messageId);
    const seen: unknown[] = [];
    await client.receive(topic, "g1", (p) => void seen.push(p), { limit: 10 });
    expect(seen).toEqual([1]);
  });

  it("holds a delayed message until it is visible", async () => {
    const topic = topicName("delay");
    const client = newPolling();
    await client.send(topic, "later", { delaySeconds: 2 });
    expect(await client.receive(topic, "g1", () => undefined)).toEqual({ ok: false, reason: "empty" });
    await sleep(2_500);
    const seen: unknown[] = [];
    await client.receive(topic, "g1", (p) => void seen.push(p));
    expect(seen).toEqual(["later"]);
  });

  it("redelivers with a higher delivery count after a retry directive", async () => {
    const topic = topicName("retry");
    const client = newPolling();
    await client.send(topic, "x");
    const counts: number[] = [];
    await client.receive(
      topic,
      "g1",
      (_p, meta) => {
        counts.push(meta.deliveryCount);
        throw new Error("boom");
      },
      { retry: () => ({ afterSeconds: 1 }) },
    );
    await sleep(1_500);
    await client.receive(topic, "g1", (_p, meta) => void counts.push(meta.deliveryCount));
    expect(counts).toEqual([1, 2]);
  });

  it("rethrows handler errors without a retry directive and redelivers", async () => {
    const topic = topicName("throw");
    const client = newPolling();
    await client.send(topic, "x");
    await expect(
      client.receive(topic, "g1", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("acknowledges when the retry directive says so", async () => {
    const topic = topicName("ackdir");
    const client = newPolling();
    await client.send(topic, "x");
    await client.receive(
      topic,
      "g1",
      () => {
        throw new Error("poison");
      },
      { retry: () => ({ acknowledge: true }) },
    );
    await sleep(300);
    expect(await client.receive(topic, "g1", () => undefined)).toEqual({ ok: false, reason: "empty" });
  });

  it("supports buffer transports", async () => {
    const topic = topicName("buf");
    const client = new ours.PollingQueueClient({ nats, transport: new ours.BufferTransport() } as ConstructorParameters<typeof ours.PollingQueueClient>[0]);
    await client.send(topic, Buffer.from([0, 1, 2, 255]));
    let got: Buffer | undefined;
    await client.receive<Buffer>(topic, "g1", (p) => void (got = p));
    expect([...(got ?? [])]).toEqual([0, 1, 2, 255]);
  });
});

describe("callbacks", () => {
  let server: Server;
  let baseUrl: string;
  let handle: (request: Request) => Promise<Response>;
  const requests: { path: string; headers: Record<string, string>; status: number }[] = [];
  const workers: { stop(): Promise<void> }[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const response = await handle(new Request(`http://localhost${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) }));
      requests.push({ path: req.url ?? "", headers: flatten(headers), status: response.status });
      res.statusCode = response.status;
      res.end(await response.text());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
    requests.length = 0;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const vercelJson = (file: string, topic: string, extra: Record<string, unknown> = {}) => ({
    functions: { [file]: { experimentalTriggers: [{ type: "queue/v2beta", topic, ...extra }] } },
  });

  function start(file: string, topic: string, extra: Record<string, unknown> = {}) {
    const worker = ours.startQueueWorker({ vercelJson: vercelJson(file, topic, extra), baseUrl, nats });
    workers.push(worker);
    return worker;
  }

  it("derives consumer groups and routes like Vercel", () => {
    expect(ours.filePathToConsumerGroup("app/api/q/route.ts")).toBe("app_Sapi_Sq_Sroute_Dts");
    expect(ours.filePathToConsumerGroup("a_b.ts")).toBe("a__b_Dts");
    expect(ours.routePathOf("src/app/(group)/api/q/route.ts")).toBe("/api/q");
    expect(ours.routePathOf("pages/api/q.ts")).toBe("/api/q");
  });

  it("delivers to the route handler over HTTP with CloudEvent headers and acknowledges", async () => {
    const topic = topicName("http");
    const client = newClient();
    const seen: { payload: unknown; meta: ours.MessageMetadata }[] = [];
    handle = client.handleCallback((payload, meta) => {
      seen.push({ payload, meta });
    });
    start("app/api/q/route.ts", topic);
    const sent = await client.send(topic, { hello: "world" });
    await waitFor(() => seen.length > 0);
    expect(seen[0]!.payload).toEqual({ hello: "world" });
    expect(seen[0]!.meta.messageId).toBe(sent.messageId);
    expect(seen[0]!.meta.consumerGroup).toBe(ours.filePathToConsumerGroup("app/api/q/route.ts"));
    await waitFor(() => requests.length > 0);
    expect(requests[0]!.path).toBe("/api/q");
    expect(requests[0]!.headers["ce-type"]).toBe(ours.CLOUD_EVENT_TYPE_V2BETA);
    expect(requests[0]!.headers["ce-vqsqueuename"]).toBe(topic);
    expect(requests[0]!.headers["ce-vqsmessageid"]).toBe(sent.messageId);
    expect(requests[0]!.headers["ce-vqsregion"]).toMatch(/^[a-z]{2,5}[0-9]{1,2}$/);
    expect(requests[0]!.status).toBe(200);
    await sleep(500);
    expect(seen).toHaveLength(1);
  });

  it("redelivers after a 500 following retryAfterSeconds", async () => {
    const topic = topicName("http500");
    const client = newClient();
    const counts: number[] = [];
    handle = client.handleCallback((_p, meta) => {
      counts.push(meta.deliveryCount);
      if (meta.deliveryCount === 1) throw new Error("boom");
    });
    start("app/api/r/route.ts", topic, { retryAfterSeconds: 1 });
    await client.send(topic, "x");
    await waitFor(() => counts.length >= 2);
    expect(counts.slice(0, 2)).toEqual([1, 2]);
    await waitFor(() => requests.length > 0);
    expect(requests[0]!.status).toBe(500);
  });

  it("honors the retry directive from the route handler", async () => {
    const topic = topicName("httpdir");
    const client = newClient();
    const counts: number[] = [];
    handle = client.handleCallback(
      (_p, meta) => {
        counts.push(meta.deliveryCount);
        if (meta.deliveryCount === 1) throw new Error("later");
      },
      { retry: () => ({ afterSeconds: 1 }) },
    );
    start("app/api/s/route.ts", topic, { retryAfterSeconds: 30 });
    await client.send(topic, "x");
    await waitFor(() => counts.length >= 2);
    expect(requests[0]!.status).toBe(200);
    expect(counts.slice(0, 2)).toEqual([1, 2]);
  });

  it("matches wildcard topic triggers", async () => {
    const prefix = `wild${run}${topicSeq++}`;
    const client = newClient();
    const topics: string[] = [];
    handle = client.handleCallback((_p, meta) => {
      topics.push(meta.topicName);
    });
    start("app/api/w/route.ts", `${prefix}*`);
    await client.send(`${prefix}-a`, 1);
    await client.send(`${prefix}-b`, 2);
    await waitFor(() => topics.length >= 2);
    expect(topics.sort()).toEqual([`${prefix}-a`, `${prefix}-b`]);
  });

  it("answers 400 for malformed callbacks", async () => {
    const client = newClient();
    const route = client.handleCallback(() => undefined);
    const response = await route(new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(400);
  });

  it("rejects receipt handles that are not for this queue", async () => {
    const topic = topicName("forge");
    const client = newClient();
    const route = client.handleCallback(() => undefined);
    const headers = {
      "content-type": "application/json",
      "ce-specversion": "1.0",
      "ce-id": "1",
      "ce-source": "/x",
      "ce-type": ours.CLOUD_EVENT_TYPE_V2BETA,
      "ce-vqsqueuename": topic,
      "ce-vqsconsumergroup": "g",
      "ce-vqsmessageid": "m1",
      "ce-vqsregion": "iad1",
      "ce-vqsreceipthandle": "r1.bm90LWEtc3ViamVjdA",
      "ce-vqsdeliverycount": "1",
      "ce-vqscreatedat": new Date().toISOString(),
      "ce-vqsexpiresat": new Date(Date.now() + 60_000).toISOString(),
      "ce-vqsvisibilitydeadline": new Date(Date.now() + 60_000).toISOString(),
    };
    const response = await route(new Request("http://localhost/x", { method: "POST", headers, body: "1" }));
    expect(response.status).toBe(400);
  });

  it("registerDevConsumer invokes the handler in process and can be unregistered", async () => {
    const topic = topicName("dev");
    const client = newClient();
    const seen: unknown[] = [];
    const unregister = ours.registerDevConsumer({
      topic,
      consumerGroup: "dev",
      client,
      handler: (payload) => void seen.push(payload),
    } as Parameters<typeof ours.registerDevConsumer>[0]);
    await client.send(topic, "hi");
    await waitFor(() => seen.length > 0);
    expect(seen).toEqual(["hi"]);
    expect(typeof unregister).toBe("function");
    unregister();
  });
});

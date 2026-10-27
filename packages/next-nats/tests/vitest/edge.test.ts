import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { headers as natsHeaders } from "@nats-io/nats-core";
import {
  closeEdgeNats,
  configureEdgeNats,
  corePublish,
  edgeKv,
  edgeNatsConfig,
  edgeNatsConfigFromEnv,
  edgeRequest,
  EdgeRequestError,
  edgeSseFromSubject,
  edgeSubscribe,
  getEdgeNats,
  jsPublish,
  resetEdgeKvHandles,
  TraceContext,
} from "../../src/edge/index.js";
import { closeNats, connectNats } from "../../src/connection.js";
import { Redis } from "../../src/redis/index.js";
import { dockerAvailable, startNatsContainer, type NatsContainer } from "../support/nats-container.js";

describe("edge config", () => {
  it("requires wsServers", () => {
    expect(() => edgeNatsConfig({})).toThrow(/wsServers/);
    expect(() => edgeNatsConfigFromEnv({})).toThrow(/NATS_WS_SERVERS/);
  });

  it("reads servers, name and auth from env", () => {
    const config = edgeNatsConfigFromEnv({ NATS_WS_SERVERS: "ws://a:8080, wss://b:443", NATS_TOKEN: "t", NATS_NAME: "svc", NATS_TIMEOUT: "2s" });
    expect(config.wsServers).toEqual(["ws://a:8080", "wss://b:443"]);
    expect(config.name).toBe("svc");
    expect(config.auth.kind).toBe("token");
    expect(config.timeout).toBe(2_000);
    expect(config.maxReconnectAttempts).toBe(-1);
  });

  it("never reads process.env from the input path", () => {
    vi.stubEnv("NATS_WS_SERVERS", "ws://junk");
    vi.stubEnv("NATS_TOKEN", "junk");
    try {
      expect(() => edgeNatsConfig({})).toThrow(/wsServers/);
      expect(edgeNatsConfig({ wsServers: "ws://a" }).auth).toEqual({ kind: "none" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to the Synadia preset", () => {
    expect(edgeNatsConfigFromEnv({ NATS_SYNADIA: "true" }).wsServers).toEqual(["wss://connect.ngs.global:443"]);
    expect(edgeNatsConfig({ synadia: "eu" }).wsServers).toEqual(["wss://eu.geo.ngs.global:443"]);
  });

  it("rejects creds and nkey files", () => {
    expect(() => edgeNatsConfigFromEnv({ NATS_WS_SERVERS: "ws://a", NATS_CREDS: "/x.creds" })).toThrow(/NATS_CREDS/);
    expect(() => edgeNatsConfigFromEnv({ NATS_WS_SERVERS: "ws://a", NATS_CREDS: "file:///x.creds" })).toThrow(/NATS_CREDS/);
    expect(() => edgeNatsConfigFromEnv({ NATS_WS_SERVERS: "ws://a", NATS_NKEY: "/x.nk" })).toThrow(/NATS_NKEY/);
    expect(() => edgeNatsConfigFromEnv({ NATS_WS_SERVERS: "ws://a", NATS_JWT: "file:///x.jwt" })).toThrow(/NATS_JWT/);
    expect(() => edgeNatsConfig({ wsServers: "ws://a", auth: { kind: "credsFile", path: "/x" } as never })).toThrow(/UNSUPPORTED|file system/);
  });

  it("rejects both a domain and an api prefix", () => {
    expect(() => edgeNatsConfig({ wsServers: "ws://a", jsDomain: "a", jsApiPrefix: "b" })).toThrow(/mutually exclusive/);
  });

  it("accepts creds from data: and env://", () => {
    const creds = "-----BEGIN NATS USER JWT-----\nx\n------END NATS USER JWT-----\n";
    const inline = `data:;base64,${btoa(creds)}`;
    expect(edgeNatsConfigFromEnv({ NATS_WS_SERVERS: "ws://a", NATS_CREDS: inline }).auth.kind).toBe("creds");
    expect(edgeNatsConfigFromEnv({ NATS_WS_SERVERS: "ws://a", NATS_CREDS: "env://C", C: creds }).auth.kind).toBe("creds");
  });
});

const available = dockerAvailable();
const CONF = `
port: 4222
websocket { port: 8080, no_tls: true }
jetstream { store_dir: /tmp/js }
`;
const stream = `EDGE${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
let container: NatsContainer;

describe.skipIf(!available)("edge publish over websocket", () => {
  beforeAll(async () => {
    if (!available) return;
    container = await startNatsContainer(CONF, [4222, 8080]);
    const nc = await connect({ servers: `127.0.0.1:${container.port(4222)}` });
    const jsm = await jetstreamManager(nc);
    await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] });
    await nc.close();
  });

  afterEach(async () => {
    resetEdgeKvHandles();
    await closeEdgeNats();
  });

  afterAll(() => container?.stop());

  const useServer = () => configureEdgeNats({ wsServers: `ws://127.0.0.1:${container.port(8080)}` });

  it("publishes to JetStream with headers and trace context", async () => {
    useServer();
    const trace = TraceContext.generate();
    const ack = await jsPublish(`${stream}.a`, { n: 1 }, { msgId: "m1", headers: { "x-a": "b" }, trace });
    expect(ack.stream).toBe(stream);
    const nc = await connect({ servers: `127.0.0.1:${container.port(4222)}` });
    const jsm = await jetstreamManager(nc);
    const msg = await jsm.streams.getMessage(stream, { seq: ack.seq });
    expect(msg?.json()).toEqual({ n: 1 });
    expect(msg?.header.get("x-a")).toBe("b");
    expect(msg?.header.get("traceparent")).toBe(trace.traceparent);
    expect(msg?.header.get("Nats-Msg-Id")).toBe("m1");
    await nc.close();
  });

  it("delivers core publishes", async () => {
    const nc = await connect({ servers: `127.0.0.1:${container.port(4222)}` });
    const sub = nc.subscribe("edge.core");
    await nc.flush();
    useServer();
    await corePublish("edge.core", "hello", { headers: { "x-k": "v" } });
    const [m] = await Promise.all([
      (async () => {
        for await (const msg of sub) return msg;
      })(),
    ]);
    expect(m?.string()).toBe("hello");
    expect(m?.headers?.get("x-k")).toBe("v");
    await nc.close();
  });

  it("caches one connection per isolate and reconnects after close", async () => {
    useServer();
    const [a, b] = await Promise.all([getEdgeNats(), getEdgeNats()]);
    expect(a.nc).toBe(b.nc);
    await a.nc.close();
    const c = await getEdgeNats();
    expect(c.nc).not.toBe(a.nc);
    expect(c.nc.isClosed()).toBe(false);
  });

  describe("kv", () => {
    const bucket = `EDGEKV${Math.random().toString(36).slice(2, 8)}`;
    let node: Redis;

    beforeAll(async () => {
      await connectNats({ servers: `127.0.0.1:${container.port(4222)}`, name: "edge-kv-parity" });
      node = new Redis({ bucket });
      await node.set("warmup", 1);
    });

    afterAll(async () => {
      await closeNats();
    });

    it("puts, gets, lists and deletes", async () => {
      useServer();
      const kv = edgeKv(bucket);
      expect(await kv.get("a")).toBeUndefined();
      const revision = await kv.put("a", { n: 1 });
      const entry = await kv.get("a");
      expect(entry?.revision).toBe(revision);
      expect(entry?.value).toEqual({ n: 1 });
      await kv.put("b", "text");
      expect((await kv.get("b"))?.value).toBe("text");
      expect(await kv.keys("?")).toEqual(["a", "b"]);
      await kv.delete("a");
      expect(await kv.get("a")).toBeUndefined();
      expect(await kv.keys("?")).toEqual(["b"]);
    });

    it("honours expectedRevision", async () => {
      useServer();
      const kv = edgeKv(bucket);
      const first = await kv.put("cas", "1");
      await expect(kv.put("cas", "2", { expectedRevision: first + 100 })).rejects.toThrow();
      await kv.put("cas", "3", { expectedRevision: first });
      expect((await kv.get("cas"))?.value).toBe(3);
    });

    it("reads what the node client wrote, value for value", async () => {
      useServer();
      const kv = edgeKv(bucket);
      const values: [string, unknown][] = [
        ["parity:string", "from-node"],
        ["parity:object", { n: 1, nested: { ok: true }, list: [1, "two", null] }],
        ["parity:number", 42],
        ["parity:boolean", true],
        ["parity:null", null],
        ["parity:numeric-string", "007"],
        ["parity:json-string", '{"not":"parsed"}'],
        ["ünï/😀 key", "awkward"],
      ];
      for (const [key, value] of values) await node.set(key, value);
      for (const [key] of values) expect((await kv.get(key))?.value, key).toEqual(await node.get(key));
      expect((await kv.get("parity:object"))?.value).toEqual(values[1]![1]);
    });

    it("writes what the node client reads, value for value", async () => {
      useServer();
      const kv = edgeKv(bucket);
      const values: [string, unknown][] = [
        ["parity:to-node:string", "from-edge"],
        ["parity:to-node:object", { n: 1, nested: { ok: true }, list: [1, "two", null] }],
        ["parity:to-node:number", 42],
        ["parity:to-node:boolean", false],
        ["parity:to-node:numeric-string", "007"],
        ["ünï/😀 edge", "awkward"],
      ];
      for (const [key, value] of values) await kv.put(key, value);
      for (const [key, value] of values) expect(await node.get(key), key).toEqual(value);
    });

    it("shares one key space with the node client", async () => {
      useServer();
      const kv = edgeKv(bucket);
      await node.set("shared:node", 1);
      await kv.put("shared:edge", 2);
      expect(await kv.keys("shared:*")).toEqual(["shared:edge", "shared:node"]);
      expect((await node.keys("shared:*")).sort()).toEqual(["shared:edge", "shared:node"]);
      await kv.delete("shared:node");
      expect(await node.get("shared:node")).toBeNull();
      await node.del("shared:edge");
      expect(await kv.get("shared:edge")).toBeUndefined();
    });

    it("expires entries like the node client", async () => {
      useServer();
      const kv = edgeKv(bucket);
      await kv.put("ttl:edge", "soon", { ttlSeconds: 1 });
      expect((await kv.get("ttl:edge"))?.expiresAt).toBeInstanceOf(Date);
      expect(await node.get("ttl:edge")).toBe("soon");
      await node.set("ttl:node", "soon", { ex: 1 });
      expect((await kv.get("ttl:node"))?.value).toBe("soon");
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect(await kv.get("ttl:edge")).toBeUndefined();
      expect(await kv.get("ttl:node")).toBeUndefined();
      expect(await node.get("ttl:edge")).toBeNull();
    });

    it("refuses a key holding a non-string record", async () => {
      useServer();
      await node.hset("typed:hash", { field: "value" });
      await expect(edgeKv(bucket).get("typed:hash")).rejects.toMatchObject({ spec: { reason: "WRONG_TYPE", code: 9 } });
    });

    it("never creates a missing bucket", async () => {
      useServer();
      const kv = edgeKv("EDGE_MISSING");
      await expect(kv.get("x")).rejects.toMatchObject({ spec: { reason: "BUCKET_NOT_FOUND", code: 5 } });
      const nc = await connect({ servers: `127.0.0.1:${container.port(4222)}` });
      await expect((await jetstreamManager(nc)).streams.info("KV_EDGE_MISSING")).rejects.toThrow();
      await nc.close();
    });

    it("rejects an invalid bucket name", () => {
      expect(() => edgeKv("bad name")).toThrow();
    });
  });

  describe("request", () => {
    it("returns the reply and forwards headers", async () => {
      useServer();
      const nc = await connect({ servers: `127.0.0.1:${container.port(4222)}` });
      nc.subscribe("edge.echo", {
        callback: (_e, msg) => void msg.respond(JSON.stringify({ got: msg.json(), hdr: msg.headers?.get("x-k") })),
      });
      await nc.flush();
      const reply = await edgeRequest("edge.echo", { a: 1 }, { headers: { "x-k": "v" } });
      expect(reply.json()).toEqual({ got: { a: 1 }, hdr: "v" });
      await nc.close();
    });

    it("maps no responders, timeout and service errors", async () => {
      useServer();
      await expect(edgeRequest("edge.nobody", undefined, { timeout: 500 })).rejects.toMatchObject({ kind: "unavailable", status: 503 });
      const nc = await connect({ servers: `127.0.0.1:${container.port(4222)}` });
      nc.subscribe("edge.slow", { callback: () => undefined });
      nc.subscribe("edge.fail", {
        callback: (_e, msg) => {
          const h = natsHeaders();
          h.set("Nats-Service-Error", "bad input");
          h.set("Nats-Service-Error-Code", "400");
          msg.respond(new Uint8Array(), { headers: h });
        },
      });
      await nc.flush();
      await expect(edgeRequest("edge.slow", undefined, { timeout: 200 })).rejects.toMatchObject({ kind: "timeout", status: 408 });
      const error = await edgeRequest("edge.fail").catch((e) => e);
      expect(error).toBeInstanceOf(EdgeRequestError);
      expect(error).toMatchObject({ kind: "service", status: 400, message: "bad input" });
      await nc.close();
    });
  });

  describe("subscribe", () => {
    it("streams messages and unsubscribes on abort", async () => {
      useServer();
      const controller = new AbortController();
      const stream = await edgeSubscribe<{ n: number }>("edge.sub.>", { signal: controller.signal });
      const reader = stream.getReader();
      const { nc } = await getEdgeNats();
      await nc.flush();
      await corePublish("edge.sub.one", { n: 1 });
      const first = await reader.read();
      expect(first.value).toMatchObject({ subject: "edge.sub.one", data: { n: 1 } });
      controller.abort();
      expect((await reader.read()).done).toBe(true);
      expect((nc as unknown as { protocol: { subscriptions: { size(): number } } }).protocol.subscriptions.size()).toBe(0);
    });

    it("closes immediately for an already aborted signal", async () => {
      useServer();
      const stream = await edgeSubscribe("edge.sub.never", { signal: AbortSignal.abort() });
      expect((await stream.getReader().read()).done).toBe(true);
    });

    it("serves SSE and stops on abort", async () => {
      useServer();
      const controller = new AbortController();
      const response = await edgeSseFromSubject(new Request("http://x/", { signal: controller.signal }), "edge.sse.>", { heartbeat: 0 });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const { nc } = await getEdgeNats();
      await nc.flush();
      await corePublish("edge.sse.a", { hello: "world" });
      while (!text.includes("hello")) text += decoder.decode((await reader.read()).value);
      expect(text).toContain('data: {"hello":"world"}');
      controller.abort();
      expect((await reader.read()).done).toBe(true);
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@trogonstack/next-nats/kv";
import { headers as natsHeaders } from "@nats-io/nats-core";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { bundleText } from "./support/bundle.js";
import { natsServers, SELF_HOSTED_VARIANTS, type SelfHostedVariant } from "./support/env.js";
import { isolatedEnv, unique } from "./support/isolation.js";
import { openSse } from "./support/sse.js";
import { startServer, type RunningServer } from "./support/server.js";

const PORTS: Record<SelfHostedVariant, number> = { turbopack: 3851, webpack: 3852 };
const EDGE_PROVIDED_NODE_MODULES = new Set(["async_hooks", "buffer"]);

describe.each(SELF_HOSTED_VARIANTS)("%s edge runtime", (variant) => {
  const env = isolatedEnv(`edge_${variant}`);
  let server: RunningServer;
  let nc: NatsConnection;
  let node: ReturnType<typeof createClient>;

  const call = (path: string, init?: RequestInit) => fetch(`${server.origin}${path}`, init);
  const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    nc = await connect({ servers: natsServers() });
    process.env.NEXT_NATS_KV_BUCKET = env.NEXT_NATS_KV_BUCKET;
    node = createClient({});
    await node.set("warmup", 1);
    const calculator = (op: (a: number, b: number) => number | Error) => (_error: unknown, msg: { json<T>(): T; respond(data?: Uint8Array | string, opts?: { headers?: ReturnType<typeof natsHeaders> }): boolean }) => {
      const { a, b } = msg.json<{ a: number; b: number }>();
      const result = op(a, b);
      if (result instanceof Error) {
        const headers = natsHeaders();
        headers.set("Nats-Service-Error", result.message);
        headers.set("Nats-Service-Error-Code", "422");
        msg.respond(new Uint8Array(), { headers });
        return;
      }
      msg.respond(JSON.stringify({ result }));
    };
    nc.subscribe("calculator.add", { callback: calculator((a, b) => a + b) });
    nc.subscribe("calculator.divide", { callback: calculator((a, b) => (b === 0 ? new Error("Division by zero") : a / b)) });
    await nc.flush();
    server = await startServer({ variant, port: PORTS[variant], env });
  });

  afterAll(async () => {
    await server?.stop();
    await nc?.close();
  });

  it("reads, writes and deletes KV entries shared with the node client", async () => {
    const key = unique("edge");
    expect((await call(`/api/edge/kv?key=${key}`)).status).toBe(404);
    await node.set(key, { from: "node", n: 1 });
    expect(await (await call(`/api/edge/kv?key=${key}`)).json()).toEqual({ key, revision: expect.any(Number), value: { from: "node", n: 1 } });
    const put = await call("/api/edge/kv", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, value: { from: "edge", n: 2 } }) });
    expect(put.status).toBe(200);
    expect(await node.get(key)).toEqual({ from: "edge", n: 2 });
    expect((await call(`/api/edge/kv?key=${key}`, { method: "DELETE" })).status).toBe(204);
    expect(await node.get(key)).toBeNull();
    expect((await call(`/api/edge/kv?key=${key}`)).status).toBe(404);
  });

  it("calls a service over request and reply", async () => {
    const ok = await post("/api/edge/calc", { op: "add", a: 2, b: 3 });
    expect([ok.status, await ok.json()]).toEqual([200, { result: 5 }]);
    const failed = await post("/api/edge/calc", { op: "divide", a: 1, b: 0 });
    expect([failed.status, await failed.json()]).toEqual([422, expect.objectContaining({ kind: "service" })]);
  });

  it("streams core subject messages over SSE", async () => {
    const sse = await openSse(`${server.origin}/api/edge/events`);
    try {
      const id = unique("evt");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await post("/api/edge/events", { id })).status).toBe(204);
      await sse.waitFor(id);
    } finally {
      sse.close();
    }
  });

  it("ships an edge bundle with no node: import", async () => {
    const bundle = await bundleText(variant, "server", ["edge", "src"]);
    expect(bundle.length).toBeGreaterThan(0);
    expect(bundle).toContain("next-nats-edge");
    expect(bundle).not.toContain("NEXT_NATS_CACHE_NAMESPACE");
    const nodeImports = new Set([...bundle.matchAll(/\b(?:require|x)\(\s*"node:([a-z_/]+)"/g)].map((match) => match[1]!));
    expect([...nodeImports].filter((name) => !EDGE_PROVIDED_NODE_MODULES.has(name))).toEqual([]);
  });
});

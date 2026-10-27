import { hostname } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getJsIfAvailable, getNats, openObj } from "../../src/connection.js";
import { dockerAvailable, startNatsContainer, type NatsContainer } from "../support/nats-container.js";

const available = dockerAvailable();
const run = Math.random().toString(36).slice(2, 8);

const WITH_JS = `
port: 4222
http: 8222
websocket { port: 8080, no_tls: true }
jetstream { store_dir: /tmp/js, domain: hub }
`;
const WITHOUT_JS = `
port: 4222
http: 8222
`;

let withJs: NatsContainer;
let withoutJs: NatsContainer;
const tcp = (c: NatsContainer) => `nats://127.0.0.1:${c.port(4222)}`;

beforeAll(async () => {
  if (!available) return;
  [withJs, withoutJs] = await Promise.all([startNatsContainer(WITH_JS, [4222, 8222, 8080]), startNatsContainer(WITHOUT_JS, [4222, 8222])]);
});

afterAll(() => {
  withJs?.stop();
  withoutJs?.stop();
});

afterEach(() => closeNats());

describe.skipIf(!available)("connection", () => {
  it("names the connection next-nats@host:pid by default", async () => {
    await connectNats({ servers: tcp(withJs) });
    const body = (await fetch(`http://127.0.0.1:${withJs.port(8222)}/connz`).then((r) => r.json())) as { connections: { name?: string }[] };
    expect(body.connections.map((c) => c.name)).toContain(`next-nats@${hostname()}:${process.pid}`);
  });

  it("connects over tcp when the transport is auto", async () => {
    const { nc } = await connectNats({ servers: tcp(withJs), transport: "auto" });
    expect(nc.getServer()).toContain(`127.0.0.1:${withJs.port(4222)}`);
  });

  it("connects over websocket using wsServers ahead of servers", async () => {
    const { nc } = await connectNats({
      servers: "nats://127.0.0.1:1",
      wsServers: `ws://127.0.0.1:${withJs.port(8080)}`,
      transport: "ws",
    });
    expect(nc.getServer()).toContain(`127.0.0.1:${withJs.port(8080)}`);
  });

  it("falls back to servers on websocket when wsServers is unset", async () => {
    const { nc } = await connectNats({ servers: `ws://127.0.0.1:${withJs.port(8080)}`, transport: "ws" });
    expect(nc.getServer()).toContain(`127.0.0.1:${withJs.port(8080)}`);
  });
});

describe.skipIf(!available)("getJsIfAvailable", () => {
  it("returns the client when JetStream is enabled and probes once per connection", async () => {
    const { jsm, js } = await connectNats({ servers: tcp(withJs), jsDomain: "hub" });
    let probes = 0;
    const original = jsm.getAccountInfo.bind(jsm);
    jsm.getAccountInfo = () => {
      probes += 1;
      return original();
    };
    expect(await getJsIfAvailable()).toBe(js);
    expect(await getJsIfAvailable()).toBe(js);
    expect(probes).toBe(1);
  });

  it("returns undefined when the account has no JetStream, and still connects", async () => {
    await connectNats({ servers: tcp(withoutJs) });
    expect(await getJsIfAvailable()).toBeUndefined();
    expect(await getJsIfAvailable()).toBeUndefined();
  });

  it("caches the negative answer per connection", async () => {
    const { jsm } = await connectNats({ servers: tcp(withoutJs) });
    let probes = 0;
    const original = jsm.getAccountInfo.bind(jsm);
    jsm.getAccountInfo = () => {
      probes += 1;
      return original();
    };
    await getJsIfAvailable();
    await getJsIfAvailable();
    expect(probes).toBe(1);
  });

  it("probes again after a reconnect to a new connection", async () => {
    await connectNats({ servers: tcp(withJs), jsDomain: "hub" });
    expect(await getJsIfAvailable()).toBeDefined();
    await closeNats();
    await connectNats({ servers: tcp(withoutJs) });
    expect(await getJsIfAvailable()).toBeUndefined();
  });
});

describe.skipIf(!available)("jetstream domain and api prefix", () => {
  it("routes the shared clients through the domain", async () => {
    const { jsm, js } = await connectNats({ servers: tcp(withJs), jsDomain: "hub" });
    expect(jsm.getOptions().apiPrefix).toBe("$JS.hub.API");
    const name = `D_${run}`;
    await jsm.streams.add({ name, subjects: [`d.${run}.>`] });
    expect((await js.publish(`d.${run}.x`, "1")).stream).toBe(name);
    await jsm.streams.delete(name);
  });

  it("routes the shared clients through an explicit api prefix", async () => {
    const { jsm, js } = await connectNats({ servers: tcp(withJs), jsApiPrefix: "$JS.hub.API" });
    const name = `P_${run}`;
    await jsm.streams.add({ name, subjects: [`p.${run}.>`] });
    expect((await js.publish(`p.${run}.x`, "1")).stream).toBe(name);
    await jsm.streams.delete(name);
  });

  it("sees JetStream as unavailable under an unknown domain", async () => {
    await connectNats({ servers: tcp(withJs), jsDomain: "nope" });
    expect(await getJsIfAvailable()).toBeUndefined();
  });

  it("is rejected when both are set", async () => {
    expect(() => connectNats({ servers: tcp(withJs), jsDomain: "hub", jsApiPrefix: "$JS.hub.API" })).toThrow(/mutually exclusive/);
  });
});

describe.skipIf(!available)("openObj", () => {
  it("creates, caches and reopens an object store", async () => {
    await connectNats({ servers: tcp(withJs), jsDomain: "hub" });
    const bucket = `obj_${run}`;
    const store = await openObj(bucket);
    expect(await openObj(bucket)).toBe(store);
    await store.putBlob({ name: "a" }, new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode((await store.getBlob("a"))!)).toBe("hello");
    const reopened = await openObj(bucket, { create: false });
    expect(new TextDecoder().decode((await reopened.getBlob("a"))!)).toBe("hello");
    const { jsm } = await getNats();
    await jsm.streams.delete(`OBJ_${bucket}`);
  });

  it("rejects a bucket that does not exist when create is false, and does not cache the failure", async () => {
    await connectNats({ servers: tcp(withJs), jsDomain: "hub" });
    const bucket = `missing_${run}`;
    await expect(openObj(bucket, { create: false })).rejects.toBeDefined();
    await expect(openObj(bucket, { create: false })).rejects.toBeDefined();
  });

  it("rejects invalid bucket names", async () => {
    await expect(openObj("bad name")).rejects.toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { natsConfig, natsConfigFromEnv, serversForTransport } from "../../src/config.js";
import { Secret } from "../../src/secret.js";
import { authFromEnv } from "../../src/config.js";
import { synadiaRegion, synadiaServers } from "../../src/synadia-region.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const seed = "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4";
const jwt = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJqdGkiOiJYIn0.c2ln";

describe("connection name", () => {
  it("defaults to next-nats@host:pid", () => {
    expect(natsConfig().name).toMatch(new RegExp(`^next-nats@.+:${process.pid}$`));
    expect(natsConfigFromEnv({}).name).toMatch(new RegExp(`^next-nats@.+:${process.pid}$`));
  });

  it("honors NATS_NAME and the input", () => {
    expect(natsConfigFromEnv({ NATS_NAME: "svc" }).name).toBe("svc");
    expect(natsConfig({ name: "in" }).name).toBe("in");
  });
});

describe("jetstream domain and api prefix", () => {
  it("reads env and input", () => {
    expect(natsConfigFromEnv({ NATS_JS_DOMAIN: "hub" })).toMatchObject({ jsDomain: "hub" });
    expect(natsConfigFromEnv({ NATS_JS_API_PREFIX: "$JS.x.API" })).toMatchObject({ jsApiPrefix: "$JS.x.API" });
    expect(natsConfig({ jsDomain: "a" }).jsDomain).toBe("a");
  });

  it("rejects both at once", () => {
    expect(() => natsConfigFromEnv({ NATS_JS_DOMAIN: "hub", NATS_JS_API_PREFIX: "p" })).toThrow(/mutually exclusive/);
    expect(() => natsConfig({ jsDomain: "a", jsApiPrefix: "b" })).toThrow(/mutually exclusive/);
  });
});

describe("transport auto", () => {
  it("is tcp on plain node", () => {
    expect(natsConfig().transport).toBe("tcp");
    expect(natsConfig({ transport: "auto" }).transport).toBe("tcp");
  });

  it("is ws on the edge runtime", () => {
    expect(natsConfigFromEnv({ NEXT_RUNTIME: "edge" }).transport).toBe("ws");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    expect(natsConfig().transport).toBe("ws");
  });

  it("is ws on bun", () => {
    vi.stubGlobal("Bun", {});
    expect(natsConfig().transport).toBe("ws");
  });

  it("lets an explicit transport win", () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    expect(natsConfig({ transport: "tcp" }).transport).toBe("tcp");
    expect(natsConfigFromEnv({ NATS_TRANSPORT: "ws" }).transport).toBe("ws");
    expect(natsConfigFromEnv({ NATS_TRANSPORT: "tcp", NEXT_RUNTIME: "edge" }).transport).toBe("tcp");
  });

  it("falls back from wsServers to servers", () => {
    const config = natsConfig({ transport: "ws", servers: "a:1" });
    expect(serversForTransport(config)).toEqual(["a:1"]);
    const both = natsConfigFromEnv({ NATS_TRANSPORT: "ws", NATS_URL: "a:1", NATS_WS_SERVERS: "wss://w" });
    expect(serversForTransport(both)).toEqual(["wss://w"]);
    expect(serversForTransport({ ...both, transport: "tcp" })).toEqual(["a:1"]);
    expect(natsConfig({ wsServers: ["wss://x", "wss://y"] }).wsServers).toEqual(["wss://x", "wss://y"]);
  });
});

describe("synadia preset", () => {
  it("maps the global region", () => {
    expect(synadiaServers(synadiaRegion("global"))).toEqual({
      servers: ["tls://connect.ngs.global"],
      wsServers: ["wss://connect.ngs.global:443"],
    });
  });

  it.each(["eu", "us", "asia", "west.us", "east.us"])("maps %s", (region) => {
    expect(synadiaServers(synadiaRegion(region))).toEqual({
      servers: [`tls://${region}.geo.ngs.global`],
      wsServers: [`wss://${region}.geo.ngs.global:443`],
    });
  });

  it("rejects unknown regions", () => {
    expect(() => synadiaRegion("mars")).toThrow(/region/);
    expect(() => natsConfigFromEnv({ NATS_SYNADIA: "mars" })).toThrow(/region/);
  });

  it("is enabled by true or a region, from env or input", () => {
    expect(natsConfigFromEnv({ NATS_SYNADIA: "true" })).toMatchObject({ synadia: "global", servers: ["tls://connect.ngs.global"] });
    expect(natsConfigFromEnv({ NATS_SYNADIA: "eu" })).toMatchObject({ synadia: "eu", wsServers: ["wss://eu.geo.ngs.global:443"] });
    expect(natsConfig({ synadia: true })).toMatchObject({ synadia: "global" });
    expect(natsConfig({ synadia: "us" })).toMatchObject({ synadia: "us" });
    expect(natsConfig({ synadia: { region: "west.us" } })).toMatchObject({ synadia: "west.us" });
    expect(natsConfig({ synadia: {} }).synadia).toBe("global");
    expect(natsConfigFromEnv({ NATS_SYNADIA: "false" }).synadia).toBeUndefined();
    expect(natsConfig().synadia).toBeUndefined();
  });

  it("lets servers and wsServers override each list independently", () => {
    const servers = natsConfigFromEnv({ NATS_SYNADIA: "true", NATS_URL: "tls://mine:4222" });
    expect(servers.servers).toEqual(["tls://mine:4222"]);
    expect(servers.wsServers).toEqual(["wss://connect.ngs.global:443"]);
    const ws = natsConfig({ synadia: { region: "us" }, wsServers: "wss://mine" });
    expect(ws.wsServers).toEqual(["wss://mine"]);
    const wsEnv = natsConfigFromEnv({ NATS_SYNADIA: "true", NATS_WS_SERVERS: "wss://mine" });
    expect(wsEnv.servers).toEqual(["tls://connect.ngs.global"]);
    expect(wsEnv.wsServers).toEqual(["wss://mine"]);
  });

  it("is idempotent when a resolved config is passed back in", () => {
    const resolved = natsConfigFromEnv({ NATS_SYNADIA: "eu" });
    expect(natsConfig(resolved)).toEqual(resolved);
  });
});

describe("jwt and bearer auth", () => {
  it("builds jwt and bearer from literal values", () => {
    const jwtAuth = authFromEnv({ NATS_JWT: jwt, NATS_SEED: seed });
    expect(jwtAuth.kind === "jwt" && [jwtAuth.userJwt.reveal(), jwtAuth.seed.reveal()]).toEqual([jwt, seed]);
    const bearer = authFromEnv({ NATS_JWT: jwt });
    expect(bearer.kind === "bearer" && bearer.userJwt.reveal()).toBe(jwt);
  });

  it("normalizes input into secrets", () => {
    expect(natsConfig({ auth: { kind: "jwt", userJwt: "j", seed: "s" } }).auth).toEqual({ kind: "jwt", userJwt: Secret.of("j"), seed: Secret.of("s") });
    expect(natsConfig({ auth: { kind: "bearer", userJwt: "j" } }).auth).toEqual({ kind: "bearer", userJwt: Secret.of("j") });
  });
});

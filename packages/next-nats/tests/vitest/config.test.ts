import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authFromEnv, decodeCreds, natsConfig, natsConfigFromEnv, parseServers, type NatsAuth } from "../../src/config.js";
import { Secret } from "../../src/secret.js";
import { bucketName, subject } from "../../src/values.js";

const seed = "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4";
const jwt = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJqdGkiOiJYIn0.c2ln";
const creds = "-----BEGIN NATS USER JWT-----\nabc\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\nSUAX\n------END USER NKEY SEED------\n";

function revealed(auth: NatsAuth): Record<string, unknown> {
  return Object.fromEntries(Object.entries(auth).map(([key, value]) => [key, value instanceof Secret ? value.reveal() : value]));
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nn-config-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("natsConfig", () => {
  it("builds defaults", () => {
    const c = natsConfig();
    expect(c.servers).toEqual(["nats://127.0.0.1:4222"]);
    expect(c.transport).toBe("tcp");
    expect(c.workers).toBe(false);
    expect(c.auth).toEqual({ kind: "none" });
    expect(c.tls).toBeUndefined();
    expect(c).toMatchObject({ timeout: 10_000, maxReconnectAttempts: -1, reconnectTimeWait: 2_000, drainTimeout: 10_000 });
  });

  it("never reads process.env", () => {
    vi.stubEnv("NATS_URL", "nats://junk:1");
    vi.stubEnv("NATS_WS_SERVERS", "wss://junk");
    vi.stubEnv("NATS_TRANSPORT", "ws");
    vi.stubEnv("NATS_NAME", "junk");
    vi.stubEnv("NATS_TOKEN", "junk");
    vi.stubEnv("NATS_USER", "junk");
    vi.stubEnv("NATS_PASSWORD", "junk");
    vi.stubEnv("NATS_CREDS", "/junk.creds");
    vi.stubEnv("NATS_NKEY", "/junk.nk");
    vi.stubEnv("NATS_JWT", jwt);
    vi.stubEnv("NATS_SEED", seed);
    vi.stubEnv("NATS_CA", "/junk");
    vi.stubEnv("NATS_TLS", "true");
    vi.stubEnv("NATS_SYNADIA", "eu");
    vi.stubEnv("NATS_JS_DOMAIN", "junk");
    vi.stubEnv("NATS_WORKERS", "true");
    vi.stubEnv("NATS_TIMEOUT", "1s");
    vi.stubEnv("NATS_MAX_RECONNECT_ATTEMPTS", "3");
    vi.stubEnv("NATS_RECONNECT_TIME_WAIT", "1s");
    vi.stubEnv("NATS_DRAIN_TIMEOUT", "1s");
    try {
      const c = natsConfig();
      expect(c).toMatchObject({
        servers: ["nats://127.0.0.1:4222"],
        transport: "tcp",
        auth: { kind: "none" },
        workers: false,
        timeout: 10_000,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2_000,
        drainTimeout: 10_000,
      });
      expect(c.name).toMatch(/^next-nats@/);
      expect(c.wsServers).toBeUndefined();
      expect(c.tls).toBeUndefined();
      expect(c.synadia).toBeUndefined();
      expect(c.jsDomain).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("accepts durations as text, number or Duration", () => {
    expect(natsConfig({ timeout: "5s", reconnectTimeWait: 500, drainTimeout: "1m30s" })).toMatchObject({
      timeout: 5_000,
      reconnectTimeWait: 500,
      drainTimeout: 90_000,
    });
    expect(() => natsConfig({ timeout: "soon" })).toThrow(/duration/i);
  });

  it("is spreadable to override one field", () => {
    const base = natsConfigFromEnv({ NATS_URL: "nats://a:1", NATS_WORKERS: "true" });
    const next = natsConfig({ ...base, auth: { kind: "token", token: "t" } });
    expect(next).toMatchObject({ servers: ["nats://a:1"], workers: true });
    expect(revealed(next.auth)).toEqual({ kind: "token", token: "t" });
  });

  it("parses servers", () => {
    expect(parseServers(" a:1, b:2 ,")).toEqual(["a:1", "b:2"]);
  });
});

describe("natsConfigFromEnv", () => {
  it("maps every variable", () => {
    const c = natsConfigFromEnv({
      NATS_URL: "tls://a:1, tls://b:2",
      NATS_WS_SERVERS: "wss://w:443",
      NATS_TRANSPORT: "ws",
      NATS_NAME: "svc",
      NATS_TOKEN: "t",
      NATS_JS_DOMAIN: "hub",
      NATS_WORKERS: "true",
      NATS_TIMEOUT: "5s",
      NATS_MAX_RECONNECT_ATTEMPTS: "7",
      NATS_RECONNECT_TIME_WAIT: "500ms",
      NATS_DRAIN_TIMEOUT: "20000",
      NATS_TLS: "true",
      NATS_CA: "/ca",
      NATS_CERT: "/cert",
      NATS_KEY: "/key",
      NATS_TLS_FIRST: "1",
      NATS_TLS_REJECT_UNAUTHORIZED: "false",
    });
    expect(c).toMatchObject({
      servers: ["tls://a:1", "tls://b:2"],
      wsServers: ["wss://w:443"],
      transport: "ws",
      name: "svc",
      jsDomain: "hub",
      workers: true,
      timeout: 5_000,
      maxReconnectAttempts: 7,
      reconnectTimeWait: 500,
      drainTimeout: 20_000,
      tls: { caFile: "/ca", certFile: "/cert", keyFile: "/key", handshakeFirst: true, rejectUnauthorized: false },
    });
    expect(revealed(c.auth)).toEqual({ kind: "token", token: "t" });
  });

  it("maps NATS_JS_API_PREFIX and requires TLS on its own", () => {
    expect(natsConfigFromEnv({ NATS_JS_API_PREFIX: "$JS.x.API", NATS_TLS: "true" })).toMatchObject({ jsApiPrefix: "$JS.x.API", tls: {} });
  });

  it("does not mix in process.env", () => {
    vi.stubEnv("NATS_URL", "nats://junk:1");
    try {
      expect(natsConfigFromEnv({}).servers).toEqual(["nats://127.0.0.1:4222"]);
      expect(natsConfigFromEnv().servers).toEqual(["nats://junk:1"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads file:// literals for jwt and seed", () => {
    const seedPath = join(dir, "user.nk");
    const jwtPath = join(dir, "user.jwt");
    writeFileSync(seedPath, `${seed}\n`);
    writeFileSync(jwtPath, `${jwt}\r\n`);
    expect(revealed(natsConfigFromEnv({ NATS_JWT: `file://${jwtPath}`, NATS_SEED: `file://${seedPath}` }).auth)).toEqual({ kind: "jwt", userJwt: jwt, seed });
  });

  it("keeps nkey and creds paths for lazy reads", () => {
    expect(natsConfigFromEnv({ NATS_NKEY: join(dir, "later.nk") }).auth).toEqual({ kind: "nkeyFile", path: join(dir, "later.nk") });
    expect(natsConfigFromEnv({ NATS_CREDS: join(dir, "later.creds") }).auth).toEqual({ kind: "credsFile", path: join(dir, "later.creds") });
  });

  it("rejects an unreadable file:// literal", () => {
    expect(() => natsConfigFromEnv({ NATS_JWT: `file://${join(dir, "missing.jwt")}` })).toThrow(/NATS_JWT/);
  });

  it("rejects bad transport, integers and durations", () => {
    expect(() => natsConfigFromEnv({ NATS_TRANSPORT: "udp" })).toThrow();
    expect(() => natsConfigFromEnv({ NATS_MAX_RECONNECT_ATTEMPTS: "x" })).toThrow(/NATS_MAX_RECONNECT_ATTEMPTS/);
    expect(() => natsConfigFromEnv({ NATS_TIMEOUT: "x" })).toThrow(/NATS_TIMEOUT/);
  });
});

const b64 = (text: string) => `data:;base64,${Buffer.from(text).toString("base64")}`;

describe("auth from env", () => {
  const read = (files: Record<string, string>) => (path: string) => {
    if (!(path in files)) throw new Error("ENOENT");
    return files[path]!;
  };

  it("treats NATS_CREDS as a path unless it has a scheme", () => {
    expect(authFromEnv({ NATS_CREDS: "/run/secrets/nats.creds" })).toEqual({ kind: "credsFile", path: "/run/secrets/nats.creds" });
    expect(authFromEnv({ NATS_CREDS: "file:///run/secrets/nats.creds" })).toEqual({ kind: "credsFile", path: "/run/secrets/nats.creds" });
    expect(authFromEnv({ NATS_CREDS: "relative.creds" })).toEqual({ kind: "credsFile", path: "relative.creds" });
  });

  it("does not sniff creds contents", () => {
    expect(authFromEnv({ NATS_CREDS: creds })).toEqual({ kind: "credsFile", path: creds.trim() });
  });

  it("resolves inline creds from data: and env://", () => {
    expect(revealed(authFromEnv({ NATS_CREDS: b64(creds) }))).toEqual({ kind: "creds", creds });
    expect(revealed(authFromEnv({ NATS_CREDS: "data:text/plain;base64," + Buffer.from(creds).toString("base64") }))).toEqual({ kind: "creds", creds });
    expect(revealed(authFromEnv({ NATS_CREDS: "env://MY_CREDS", MY_CREDS: creds }))).toEqual({ kind: "creds", creds });
  });

  it("treats NATS_NKEY as a seed file unless it has a scheme", () => {
    expect(authFromEnv({ NATS_NKEY: "/s/seed.nk" })).toEqual({ kind: "nkeyFile", path: "/s/seed.nk" });
    expect(authFromEnv({ NATS_NKEY: "file:///s/seed.nk" })).toEqual({ kind: "nkeyFile", path: "/s/seed.nk" });
    expect(authFromEnv({ NATS_NKEY: seed })).toEqual({ kind: "nkeyFile", path: seed });
    expect(revealed(authFromEnv({ NATS_NKEY: b64(seed) }))).toEqual({ kind: "nkey", seed });
    expect(revealed(authFromEnv({ NATS_NKEY: "env://SEED", SEED: seed }))).toEqual({ kind: "nkey", seed });
  });

  it("treats jwt, seed, token and password as literals", () => {
    expect(revealed(authFromEnv({ NATS_JWT: jwt, NATS_SEED: seed }))).toEqual({ kind: "jwt", userJwt: jwt, seed });
    expect(revealed(authFromEnv({ NATS_JWT: jwt }))).toEqual({ kind: "bearer", userJwt: jwt });
    expect(revealed(authFromEnv({ NATS_TOKEN: "/not/a/path" }))).toEqual({ kind: "token", token: "/not/a/path" });
    expect(revealed(authFromEnv({ NATS_USER: "u", NATS_PASSWORD: "/not/a/path" }))).toEqual({ kind: "userpass", user: "u", pass: "/not/a/path" });
  });

  it("resolves schemes on literals and trims trailing newlines", () => {
    expect(revealed(authFromEnv({ NATS_TOKEN: b64("tok\n") }))).toEqual({ kind: "token", token: "tok" });
    expect(revealed(authFromEnv({ NATS_TOKEN: "env://T", T: "tok\r\n" }))).toEqual({ kind: "token", token: "tok" });
    expect(revealed(authFromEnv({ NATS_TOKEN: "file:///s/t" }, read({ "/s/t": "tok\r\n" })))).toEqual({ kind: "token", token: "tok" });
    expect(revealed(authFromEnv({ NATS_JWT: "file:///s/u.jwt", NATS_SEED: "file:///s/u.nk" }, read({ "/s/u.jwt": jwt, "/s/u.nk": `${seed}\n` })))).toEqual({
      kind: "jwt",
      userJwt: jwt,
      seed,
    });
    expect(revealed(authFromEnv({ NATS_USER: "u", NATS_PASSWORD: b64("pw") }))).toEqual({ kind: "userpass", user: "u", pass: "pw" });
  });

  it("rejects file:// literals where no file system exists", () => {
    expect(() => authFromEnv({ NATS_JWT: "file:///s/u.jwt" })).toThrow(/NATS_JWT/);
    expect(() => authFromEnv({ NATS_TOKEN: "file:///s/t" })).toThrow(/NATS_TOKEN/);
  });

  it("rejects plain data:, bad base64, unsupported schemes and missing env references", () => {
    expect(() => authFromEnv({ NATS_CREDS: "data:text/plain,abc" })).toThrow(/base64/);
    expect(() => authFromEnv({ NATS_CREDS: "data:;base64,@@@" })).toThrow(/base64/);
    expect(() => authFromEnv({ NATS_CREDS: "s3://bucket/user.creds" })).toThrow(/s3:\/\/ scheme is not supported/);
    expect(() => authFromEnv({ NATS_CREDS: "env://NOPE" })).toThrow(/NOPE/);
  });

  it("builds userpass and token, and none by default", () => {
    expect(revealed(authFromEnv({ NATS_USER: "u", NATS_PASSWORD: "p" }))).toEqual({ kind: "userpass", user: "u", pass: "p" });
    expect(revealed(authFromEnv({ NATS_USER: "u" }))).toEqual({ kind: "userpass", user: "u", pass: "" });
    expect(authFromEnv({})).toEqual({ kind: "none" });
  });

  it("applies the token in addition to one credential type", () => {
    expect(revealed(authFromEnv({ NATS_USER: "u", NATS_PASSWORD: "p", NATS_TOKEN: "t" }))).toEqual({ kind: "userpass", user: "u", pass: "p", token: "t" });
    expect(revealed(authFromEnv({ NATS_JWT: jwt, NATS_TOKEN: "t" }))).toEqual({ kind: "bearer", userJwt: jwt, token: "t" });
    expect(authFromEnv({ NATS_CREDS: "/c", NATS_TOKEN: "t" })).toMatchObject({ kind: "credsFile", path: "/c" });
    expect(revealed(authFromEnv({ NATS_NKEY: b64(seed), NATS_TOKEN: "t" }))).toEqual({ kind: "nkey", seed, token: "t" });
  });

  it("rejects more than one of user, creds, nkey and jwt", () => {
    expect(() => authFromEnv({ NATS_USER: "u", NATS_CREDS: "/c" })).toThrow(/too many types of credentials, choose only one of user, creds, nkey, jwt/i);
    expect(() => authFromEnv({ NATS_CREDS: "/c", NATS_NKEY: "/n" })).toThrow(/NATS_CREDS, NATS_NKEY/);
    expect(() => authFromEnv({ NATS_JWT: jwt, NATS_USER: "u" })).toThrow(/NATS_USER, NATS_JWT/);
    expect(() => authFromEnv({ NATS_NKEY: "/n", NATS_JWT: jwt })).toThrow(/too many/i);
  });

  it("rejects orphaned halves", () => {
    expect(() => authFromEnv({ NATS_SEED: seed })).toThrow(/NATS_JWT/);
    expect(() => authFromEnv({ NATS_PASSWORD: "p" })).toThrow(/NATS_USER/);
  });
});

describe("creds", () => {
  it("accepts a creds file and rejects everything else", () => {
    expect(new TextDecoder().decode(decodeCreds(creds))).toBe(creds.trim());
    expect(() => decodeCreds("junk")).toThrow(/creds/);
    expect(() => decodeCreds(Buffer.from(creds).toString("base64"))).toThrow(/creds/);
  });
});

describe("values", () => {
  it("validates value objects", () => {
    expect(subject("a.b.>")).toBe("a.b.>");
    expect(() => subject("a..b")).toThrow();
    expect(() => bucketName("bad name")).toThrow();
  });
});

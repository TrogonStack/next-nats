import { describe, expect, it } from "vitest";
import { authFromEnv, decodeCreds, parseServers, resolveConfig } from "../src/config.js";
import { bucketName, subject } from "../src/values.js";

describe("config", () => {
  it("defaults", () => {
    const c = resolveConfig({}, {});
    expect(c.servers).toEqual(["nats://127.0.0.1:4222"]);
    expect(c.transport).toBe("tcp");
    expect(c.workers).toBe(false);
    expect(c.auth).toEqual({ kind: "none" });
    expect(c.tls).toBeUndefined();
  });

  it("parses servers", () => {
    expect(parseServers(" a:1, b:2 ,")).toEqual(["a:1", "b:2"]);
  });

  it("reads env", () => {
    const c = resolveConfig(
      {},
      { NATS_SERVERS: "wss://x", NATS_TRANSPORT: "ws", NATS_WORKERS: "true", NATS_TIMEOUT: "500", NATS_TLS_CA_FILE: "/ca" },
    );
    expect(c).toMatchObject({ servers: ["wss://x"], transport: "ws", workers: true, timeout: 500, tls: { caFile: "/ca" } });
  });

  it("rejects bad transport and ints", () => {
    expect(() => resolveConfig({}, { NATS_TRANSPORT: "udp" })).toThrow();
    expect(() => resolveConfig({}, { NATS_TIMEOUT: "x" })).toThrow();
  });

  it("auth priority", () => {
    expect(authFromEnv({ NATS_TOKEN: "t", NATS_USER: "u" })).toEqual({ kind: "token", token: "t" });
    expect(authFromEnv({ NATS_USER: "u", NATS_PASS: "p" })).toEqual({ kind: "userpass", user: "u", pass: "p" });
    expect(authFromEnv({ NATS_NKEY_SEED: "SU" , NATS_TOKEN: "t" })).toEqual({ kind: "nkey", seed: "SU" });
    expect(authFromEnv({ NATS_CREDS_FILE: "/c", NATS_TOKEN: "t" })).toEqual({ kind: "credsFile", path: "/c" });
    expect(authFromEnv({ NATS_CREDS: "c", NATS_CREDS_FILE: "/c" })).toEqual({ kind: "creds", creds: "c" });
  });

  it("decodes raw and base64 creds, rejects junk", () => {
    const raw = "-----BEGIN NATS USER JWT-----\nabc\n------END NATS USER JWT------";
    expect(new TextDecoder().decode(decodeCreds(raw))).toBe(raw);
    expect(new TextDecoder().decode(decodeCreds(Buffer.from(raw).toString("base64")))).toBe(raw);
    expect(() => decodeCreds("junk")).toThrow(/creds/);
  });

  it("validates value objects", () => {
    expect(subject("a.b.>")).toBe("a.b.>");
    expect(() => subject("a..b")).toThrow();
    expect(() => bucketName("bad name")).toThrow();
  });
});

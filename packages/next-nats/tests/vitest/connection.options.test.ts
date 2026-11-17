import { describe, expect, it } from "vitest";
import { natsConfig, type NatsTlsConfig } from "../../src/config.js";
import { buildConnectionOptions } from "../../src/connection.js";
import { InvalidArgumentError } from "../../src/errors.js";

const ws = (tls: NatsTlsConfig) => buildConnectionOptions(natsConfig({ transport: "ws", servers: "wss://h:443", tls }));

describe("buildConnectionOptions", () => {
  it("keeps tls for tcp", () => {
    const opts = buildConnectionOptions(natsConfig({ transport: "tcp", tls: { caFile: "/ca.pem" } }));
    expect(opts.tls).toEqual({ caFile: "/ca.pem" });
    expect(opts).not.toHaveProperty("wssOnly");
  });

  it("leaves tls and wssOnly unset for ws without tls config", () => {
    const opts = buildConnectionOptions(natsConfig({ transport: "ws", servers: "ws://h:80" }));
    expect(opts).not.toHaveProperty("tls");
    expect(opts).not.toHaveProperty("wssOnly");
  });

  // wsconnect() rejects any tls option; over WebSocket, requiring TLS means requiring wss.
  it("turns required tls into wssOnly for ws", () => {
    const opts = ws({});
    expect(opts).not.toHaveProperty("tls");
    expect(opts).toMatchObject({ wssOnly: true });
  });

  it("accepts settings a WebSocket already satisfies", () => {
    expect(ws({ handshakeFirst: true, rejectUnauthorized: true })).toMatchObject({ wssOnly: true });
  });

  it.each([{ caFile: "/ca.pem" }, { certFile: "/c.pem" }, { keyFile: "/k.pem" }, { rejectUnauthorized: false }])(
    "rejects %o for ws instead of dropping it",
    (tls) => {
      expect(() => ws(tls)).toThrow(InvalidArgumentError);
      expect(() => ws(tls)).toThrow(/transport "tcp"/);
    },
  );
});

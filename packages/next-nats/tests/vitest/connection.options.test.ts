import { describe, expect, it } from "vitest";
import { natsConfig } from "../../src/config.js";
import { buildConnectionOptions } from "../../src/connection.js";

describe("buildConnectionOptions", () => {
  it("keeps tls for tcp", () => {
    const opts = buildConnectionOptions(natsConfig({ transport: "tcp", tls: { caFile: "/ca.pem" } }));
    expect(opts.tls).toEqual({ caFile: "/ca.pem" });
  });

  // wsconnect() rejects any tls option; the wss:// scheme carries the encryption instead.
  it("leaves tls out for ws", () => {
    const opts = buildConnectionOptions(natsConfig({ transport: "ws", servers: "wss://h:443", tls: {} }));
    expect(opts).not.toHaveProperty("tls");
  });
});

import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { authFromEnv, natsConfig, natsConfigFromEnv } from "../../src/config.js";
import { Secret, secretFromEnv } from "../../src/secret.js";

describe("secret", () => {
  it("accepts plain values", () => {
    expect(Secret.parse("hunter2").reveal()).toBe("hunter2");
  });

  it("unwraps the secret value syntax", () => {
    expect(Secret.parse("secret:github:ghp:ghp_abc").reveal()).toBe("ghp_abc");
    expect(Secret.parse("secret::: x").reveal()).toBe(" x");
    expect(Secret.parse("secret:a:b:c:d").reveal()).toBe("c:d");
    expect(Secret.parse("secret:a:b:line1\nline2").reveal()).toBe("line1\nline2");
  });

  it("keeps values that only look similar", () => {
    expect(Secret.parse("secret:UPPER:x:v").reveal()).toBe("secret:UPPER:x:v");
    expect(Secret.parse("secret:a:b:").reveal()).toBe("secret:a:b:");
    expect(Secret.parse("secret:a").reveal()).toBe("secret:a");
  });

  it("redacts on every string path", () => {
    const secret = Secret.of("hunter2");
    const rendered = [String(secret), `${secret}`, JSON.stringify({ secret }), inspect({ secret }), JSON.stringify(secret)];
    for (const text of rendered) expect(text).not.toContain("hunter2");
  });

  it("treats empty env values as unset", () => {
    expect(secretFromEnv("")).toBeUndefined();
    expect(secretFromEnv(undefined)).toBeUndefined();
  });

  it("applies the syntax to every auth secret in env", () => {
    expect(authFromEnv({ NATS_TOKEN: "secret:nats:token:t0k" })).toEqual({ kind: "token", token: Secret.of("t0k") });
    expect(authFromEnv({ NATS_USER: "u", NATS_PASSWORD: "secret:nats:pw:p" })).toEqual({
      kind: "userpass",
      user: "u",
      pass: Secret.of("p"),
    });
    const seed = "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4";
    const auth = authFromEnv({ NATS_JWT: "secret:nats:jwt:j", NATS_SEED: `secret:nats:seed:${seed}` });
    expect(auth.kind === "jwt" && auth.seed.reveal()).toBe(seed);
  });

  it("never leaks auth through config serialization", () => {
    const config = natsConfigFromEnv({ NATS_TOKEN: "secret:nats:token:t0k" });
    expect(JSON.stringify(config)).not.toContain("t0k");
    expect(inspect(config, { depth: 5 })).not.toContain("t0k");
  });

  it("accepts string secrets in explicit config", () => {
    const config = natsConfig({ auth: { kind: "token", token: "secret:nats:token:t0k" } });
    expect(config.auth).toEqual({ kind: "token", token: Secret.of("t0k") });
  });
});

import { describe, expect, it } from "vitest";
import { assessExpiry, CredentialsExpiredError, jwtExpiry, jwtFromCreds, JWT_EXPIRY_WARNING_MS } from "../../src/jwt.js";
import { Code } from "../../src/errors.js";
import { createTestOperator } from "../support/jwt.js";

const op = createTestOperator();
const at = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

describe("jwt expiry", () => {
  it("decodes the exp claim", () => {
    const exp = at(3600);
    expect(jwtExpiry(op.user("a", exp).jwt)?.getTime()).toBe(exp * 1000);
  });

  it("returns undefined without exp or for junk", () => {
    expect(jwtExpiry(op.user("a").jwt)).toBeUndefined();
    expect(jwtExpiry("junk")).toBeUndefined();
    expect(jwtExpiry("a.b.c")).toBeUndefined();
  });

  it("extracts the jwt from a creds file", () => {
    const user = op.user("a");
    expect(jwtFromCreds(user.creds)).toBe(user.jwt);
    expect(jwtFromCreds("nope")).toBeUndefined();
  });
});

describe("expiry assessment", () => {
  const now = Date.UTC(2026, 0, 1);

  it("passes when there is no expiry or plenty of time", () => {
    expect(assessExpiry("x", undefined, now).status).toBe("no-expiry");
    expect(assessExpiry("x", new Date(now + JWT_EXPIRY_WARNING_MS + 1000), now).status).toBe("ok");
  });

  it("warns under 24h", () => {
    const verdict = assessExpiry("x", new Date(now + 60_000), now);
    expect(verdict).toMatchObject({ status: "expiring", remainingMs: 60_000 });
  });

  it("fails with a typed error when expired", () => {
    try {
      assessExpiry("NATS creds", new Date(now - 1), now);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialsExpiredError);
      expect((error as CredentialsExpiredError).spec).toMatchObject({ code: Code.FAILED_PRECONDITION, reason: "CREDENTIALS_EXPIRED" });
      expect((error as CredentialsExpiredError).message).not.toMatch(/eyJ/);
    }
  });
});

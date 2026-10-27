import { FailedPreconditionError } from "./errors.js";
import { Secret } from "./secret.js";

export const JWT_EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const CREDS_JWT = /-{3,}BEGIN NATS USER JWT-{3,}\s+(\S+)\s+-{3,}END NATS USER JWT-{3,}/;

export function jwtFromCreds(creds: string): string | undefined {
  return CREDS_JWT.exec(creds)?.[1];
}

export function jwtExpiry(jwt: string | Secret): Date | undefined {
  const token = Secret.of(jwt).reveal().trim();
  if (!JWT_SHAPE.test(token)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0 ? new Date(payload.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

export class CredentialsExpiredError extends FailedPreconditionError {
  readonly expiresAt: Date;

  constructor(source: string, expiresAt: Date) {
    super({
      domain: "next-nats.credentials",
      reason: "CREDENTIALS_EXPIRED",
      message: `${source} credentials expired at ${expiresAt.toISOString()}`,
    });
    this.expiresAt = expiresAt;
  }
}

export type ExpiryVerdict = { status: "no-expiry" } | { status: "ok"; expiresAt: Date } | { status: "expiring"; expiresAt: Date; remainingMs: number };

export function assessExpiry(source: string, expiresAt: Date | undefined, now: number = Date.now()): ExpiryVerdict {
  if (!expiresAt) return { status: "no-expiry" };
  const remainingMs = expiresAt.getTime() - now;
  if (remainingMs <= 0) throw new CredentialsExpiredError(source, expiresAt);
  return remainingMs < JWT_EXPIRY_WARNING_MS ? { status: "expiring", expiresAt, remainingMs } : { status: "ok", expiresAt };
}

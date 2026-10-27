import { duration } from "./duration.js";
import { byteSize } from "./size.js";
import { invalidArgument } from "./errors.js";

export type Env = Record<string, string | undefined>;

export function envBool(env: Env, key: string): boolean | undefined {
  const value = env[key];
  if (value === undefined || value === "") return undefined;
  return value === "true" || value === "1";
}

export function envInt(env: Env, key: string): number | undefined {
  const value = env[key];
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw invalidArgument("next-nats.config", "INVALID_INTEGER", `${key} must be an integer, got "${value}"`);
  return n;
}

export function envMillis(env: Env, key: string): number | undefined {
  const value = env[key]?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  try {
    return duration(value).millis;
  } catch {
    throw invalidArgument("next-nats.config", "INVALID_DURATION", `${key} must be a duration such as "5s" or "500ms", or milliseconds, got "${value}"`);
  }
}

export function envBytes(env: Env, key: string): number | undefined {
  const value = env[key]?.trim();
  if (value === undefined || value === "") return undefined;
  try {
    return byteSize(value).toBytes();
  } catch {
    throw invalidArgument("next-nats.config", "INVALID_SIZE", `${key} must be a size such as "128MiB" or "1GiB", or bytes, got "${value}"`);
  }
}

export function envString(env: Env, key: string): string | undefined {
  return env[key] || undefined;
}

export function envSynadia(env: Env): true | { region: string } | undefined {
  const raw = env.NATS_SYNADIA?.trim().toLowerCase();
  if (!raw || raw === "false" || raw === "0") return undefined;
  return raw === "true" || raw === "1" ? true : { region: raw };
}

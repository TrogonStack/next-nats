import { invalidArgument } from "./errors.js";
import { Secret, secretFromEnv } from "./secret.js";

type Env = Record<string, string | undefined>;

export type ReadFile = (path: string) => string;

export type Location = { kind: "file"; path: string } | { kind: "inline"; value: Secret };

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;
const DATA = /^data:([^,;]*(?:;[^,;]+)*);base64,(.*)$/is;
const SUPPORTED = new Set(["env", "file"]);

function fail(key: string, reason: string, message: string): never {
  throw invalidArgument("next-nats.config", reason, `${key}: ${message}`);
}

function decodeData(key: string, value: string): string {
  const match = DATA.exec(value);
  if (!match) fail(key, "INVALID_DATA_URI", 'a data: value must look like "data:[<mediatype>];base64,<payload>"; the ;base64 token is required');
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(match[2]!.trim()), (ch) => ch.charCodeAt(0)));
  } catch {
    return fail(key, "INVALID_DATA_URI", "the data: payload is not valid base64");
  }
}

function fromEnvVar(env: Env, key: string, name: string): string {
  const value = env[name];
  if (!value) fail(key, "MISSING_ENV_REFERENCE", `env://${name} refers to an unset or empty variable`);
  return value;
}

function scheme(key: string, value: string): { name: string; rest: string } | undefined {
  const match = SCHEME.exec(value);
  if (!match) return undefined;
  const name = match[1]!.toLowerCase();
  if (!SUPPORTED.has(name)) fail(key, "UNSUPPORTED_SCHEME", `the ${name}:// scheme is not supported, use a file path, file://, data: or env://`);
  return { name, rest: match[2]! };
}

export function locationFromEnv(env: Env, key: string): Location | undefined {
  const raw = secretFromEnv(env[key]);
  if (!raw) return undefined;
  const value = raw.reveal().trim();
  if (value.startsWith("data:")) return { kind: "inline", value: Secret.of(decodeData(key, value)) };
  const parsed = scheme(key, value);
  if (parsed?.name === "env") return { kind: "inline", value: Secret.of(fromEnvVar(env, key, parsed.rest)) };
  if (parsed?.name === "file") return { kind: "file", path: parsed.rest };
  return { kind: "file", path: value };
}

export function literalFromEnv(env: Env, key: string, read?: ReadFile): Secret | undefined {
  const raw = secretFromEnv(env[key]);
  if (!raw) return undefined;
  const value = raw.reveal();
  const trimmed = value.trim();
  if (trimmed.startsWith("data:")) return Secret.of(decodeData(key, trimmed).replace(/[\r\n]+$/, ""));
  const parsed = scheme(key, trimmed);
  if (parsed?.name === "env") return Secret.of(fromEnvVar(env, key, parsed.rest).replace(/[\r\n]+$/, ""));
  if (parsed?.name === "file") {
    if (!read) fail(key, "UNSUPPORTED_AUTH", "file:// needs a file system: use data: or env:// in this runtime");
    try {
      return Secret.of(read(parsed.rest).replace(/[\r\n]+$/, ""));
    } catch {
      return fail(key, "UNREADABLE_AUTH", `cannot read ${parsed.rest}`);
    }
  }
  return raw;
}

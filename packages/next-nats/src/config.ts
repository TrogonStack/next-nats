import { Secret, secretFromEnv } from "./secret.js";

export type NatsTransport = "tcp" | "ws";

export type NatsAuth =
  | { kind: "none" }
  | { kind: "token"; token: Secret }
  | { kind: "userpass"; user: string; pass: Secret }
  | { kind: "nkey"; seed: Secret }
  | { kind: "creds"; creds: Secret }
  | { kind: "credsFile"; path: string };

export type NatsAuthInput =
  | { kind: "none" }
  | { kind: "token"; token: string | Secret }
  | { kind: "userpass"; user: string; pass: string | Secret }
  | { kind: "nkey"; seed: string | Secret }
  | { kind: "creds"; creds: string | Secret }
  | { kind: "credsFile"; path: string };

export interface NatsTlsConfig {
  caFile?: string;
  certFile?: string;
  keyFile?: string;
  handshakeFirst?: boolean;
  rejectUnauthorized?: boolean;
}

export interface NatsConfig {
  servers: string[];
  transport: NatsTransport;
  name?: string;
  auth: NatsAuth;
  tls?: NatsTlsConfig;
  workers: boolean;
  timeout: number;
  maxReconnectAttempts: number;
  reconnectTimeWait: number;
  drainTimeout: number;
}

export type NatsConfigInput = Partial<Omit<NatsConfig, "servers" | "auth">> & {
  servers?: string | string[];
  auth?: NatsAuthInput;
};

export const DEFAULT_SERVERS = ["nats://127.0.0.1:4222"];

type Env = Record<string, string | undefined>;

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true" || value === "1";
}

function int(env: Env, key: string): number | undefined {
  const value = env[key];
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new TypeError(`${key} must be an integer, got "${value}"`);
  return n;
}

export function parseServers(value: string | string[] | undefined): string[] {
  const list = Array.isArray(value) ? value : (value ?? "").split(",");
  const servers = list.map((s) => s.trim()).filter(Boolean);
  return servers.length > 0 ? servers : [...DEFAULT_SERVERS];
}

export function normalizeAuth(auth: NatsAuthInput): NatsAuth {
  switch (auth.kind) {
    case "token":
      return { kind: "token", token: Secret.parse(auth.token) };
    case "userpass":
      return { kind: "userpass", user: auth.user, pass: Secret.parse(auth.pass) };
    case "nkey":
      return { kind: "nkey", seed: Secret.parse(auth.seed) };
    case "creds":
      return { kind: "creds", creds: Secret.parse(auth.creds) };
    default:
      return auth;
  }
}

export function authFromEnv(env: Env): NatsAuth {
  const creds = secretFromEnv(env.NATS_CREDS);
  if (creds) return { kind: "creds", creds };
  if (env.NATS_CREDS_FILE) return { kind: "credsFile", path: env.NATS_CREDS_FILE };
  const seed = secretFromEnv(env.NATS_NKEY_SEED);
  if (seed) return { kind: "nkey", seed };
  const token = secretFromEnv(env.NATS_TOKEN);
  if (token) return { kind: "token", token };
  if (env.NATS_USER) {
    return { kind: "userpass", user: env.NATS_USER, pass: secretFromEnv(env.NATS_PASS) ?? Secret.of("") };
  }
  return { kind: "none" };
}

export function tlsFromEnv(env: Env): NatsTlsConfig | undefined {
  const tls: NatsTlsConfig = {
    caFile: env.NATS_TLS_CA_FILE || undefined,
    certFile: env.NATS_TLS_CERT_FILE || undefined,
    keyFile: env.NATS_TLS_KEY_FILE || undefined,
    handshakeFirst: bool(env.NATS_TLS_HANDSHAKE_FIRST),
    rejectUnauthorized: bool(env.NATS_TLS_REJECT_UNAUTHORIZED),
  };
  const required = bool(env.NATS_TLS) === true;
  const configured = Object.values(tls).some((v) => v !== undefined);
  return required || configured ? tls : undefined;
}

export function resolveConfig(input: NatsConfigInput = {}, env: Env = process.env): NatsConfig {
  const transport = input.transport ?? ((env.NATS_TRANSPORT as NatsTransport | undefined) || "tcp");
  if (transport !== "tcp" && transport !== "ws") {
    throw new TypeError(`NATS_TRANSPORT must be "tcp" or "ws", got "${transport}"`);
  }
  return {
    servers: parseServers(input.servers ?? env.NATS_SERVERS),
    transport,
    name: input.name ?? (env.NATS_NAME || undefined),
    auth: input.auth ? normalizeAuth(input.auth) : authFromEnv(env),
    tls: input.tls ?? tlsFromEnv(env),
    workers: input.workers ?? bool(env.NATS_WORKERS) ?? false,
    timeout: input.timeout ?? int(env, "NATS_TIMEOUT") ?? 10_000,
    maxReconnectAttempts: input.maxReconnectAttempts ?? int(env, "NATS_MAX_RECONNECT_ATTEMPTS") ?? -1,
    reconnectTimeWait: input.reconnectTimeWait ?? int(env, "NATS_RECONNECT_TIME_WAIT") ?? 2_000,
    drainTimeout: input.drainTimeout ?? int(env, "NATS_DRAIN_TIMEOUT") ?? 10_000,
  };
}

const CREDS_MARKER = "BEGIN NATS USER JWT";

export function decodeCreds(value: string | Secret): Uint8Array {
  const trimmed = Secret.parse(value).reveal().trim();
  const text = trimmed.includes(CREDS_MARKER) ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  if (!text.includes(CREDS_MARKER)) {
    throw new TypeError("NATS_CREDS is not a creds file (raw or base64): missing a NATS USER JWT block");
  }
  return new TextEncoder().encode(text);
}

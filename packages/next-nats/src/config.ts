import { invalidArgument } from "./errors.js";
export type NatsTransport = "tcp" | "ws";

export type NatsAuth =
  | { kind: "none" }
  | { kind: "token"; token: string }
  | { kind: "userpass"; user: string; pass: string }
  | { kind: "nkey"; seed: string }
  | { kind: "creds"; creds: string }
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

export type NatsConfigInput = Partial<Omit<NatsConfig, "servers">> & {
  servers?: string | string[];
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
  if (!Number.isInteger(n)) throw invalidArgument("next-nats.config", "INVALID_INTEGER", `${key} must be an integer, got "${value}"`);
  return n;
}

export function parseServers(value: string | string[] | undefined): string[] {
  const list = Array.isArray(value) ? value : (value ?? "").split(",");
  const servers = list.map((s) => s.trim()).filter(Boolean);
  return servers.length > 0 ? servers : [...DEFAULT_SERVERS];
}

export function authFromEnv(env: Env): NatsAuth {
  if (env.NATS_CREDS) return { kind: "creds", creds: env.NATS_CREDS };
  if (env.NATS_CREDS_FILE) return { kind: "credsFile", path: env.NATS_CREDS_FILE };
  if (env.NATS_NKEY_SEED) return { kind: "nkey", seed: env.NATS_NKEY_SEED };
  if (env.NATS_TOKEN) return { kind: "token", token: env.NATS_TOKEN };
  if (env.NATS_USER) return { kind: "userpass", user: env.NATS_USER, pass: env.NATS_PASS ?? "" };
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
    throw invalidArgument("next-nats.config", "INVALID_TRANSPORT", `NATS_TRANSPORT must be "tcp" or "ws", got "${transport}"`);
  }
  return {
    servers: parseServers(input.servers ?? env.NATS_SERVERS),
    transport,
    name: input.name ?? (env.NATS_NAME || undefined),
    auth: input.auth ?? authFromEnv(env),
    tls: input.tls ?? tlsFromEnv(env),
    workers: input.workers ?? bool(env.NATS_WORKERS) ?? false,
    timeout: input.timeout ?? int(env, "NATS_TIMEOUT") ?? 10_000,
    maxReconnectAttempts: input.maxReconnectAttempts ?? int(env, "NATS_MAX_RECONNECT_ATTEMPTS") ?? -1,
    reconnectTimeWait: input.reconnectTimeWait ?? int(env, "NATS_RECONNECT_TIME_WAIT") ?? 2_000,
    drainTimeout: input.drainTimeout ?? int(env, "NATS_DRAIN_TIMEOUT") ?? 10_000,
  };
}

const CREDS_MARKER = "BEGIN NATS USER JWT";

export function decodeCreds(value: string): Uint8Array {
  const trimmed = value.trim();
  const text = trimmed.includes(CREDS_MARKER) ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  if (!text.includes(CREDS_MARKER)) {
    throw invalidArgument("next-nats.config", "INVALID_CREDS", "NATS_CREDS is not a creds file (raw or base64): missing a NATS USER JWT block");
  }
  return new TextEncoder().encode(text);
}

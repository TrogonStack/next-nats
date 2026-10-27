import { hostname } from "node:os";
import { invalidArgument } from "./errors.js";
import { readFileSync } from "node:fs";
import { authFromEnv, normalizeAuth, type NatsAuth, type NatsAuthInput } from "./auth.js";
import { duration, type DurationInput } from "./duration.js";
import { envBool, envBytes, envMillis, envInt, envString, envSynadia, type Env } from "./env.js";
import { byteSize, SYNADIA_DEFAULT_STREAM_MAX_BYTES, type ByteSizeInput } from "./size.js";
import { DEFAULT_SYNADIA_REGION, synadiaRegion, synadiaServers, type SynadiaRegion } from "./synadia-region.js";

export type NatsTransport = "tcp" | "ws";
export type NatsTransportInput = NatsTransport | "auto";

export interface NatsTlsConfig {
  caFile?: string;
  certFile?: string;
  keyFile?: string;
  handshakeFirst?: boolean;
  rejectUnauthorized?: boolean;
}

export type SynadiaInput = true | string | { region?: string };

export interface NatsConfig {
  servers: string[];
  wsServers?: string[];
  transport: NatsTransport;
  name: string;
  auth: NatsAuth;
  synadia?: SynadiaRegion;
  jsDomain?: string;
  jsApiPrefix?: string;
  streamMaxBytes?: number;
  tls?: NatsTlsConfig;
  workers: boolean;
  timeout: number;
  maxReconnectAttempts: number;
  reconnectTimeWait: number;
  drainTimeout: number;
}

export type NatsConfigInput = Partial<
  Omit<NatsConfig, "servers" | "wsServers" | "auth" | "transport" | "synadia" | "streamMaxBytes" | "name" | "timeout" | "reconnectTimeWait" | "drainTimeout">
> & {
  timeout?: DurationInput;
  reconnectTimeWait?: DurationInput;
  drainTimeout?: DurationInput;
  servers?: string | string[];
  wsServers?: string | string[];
  transport?: NatsTransportInput;
  name?: string;
  auth?: NatsAuthInput;
  synadia?: SynadiaInput;
  streamMaxBytes?: ByteSizeInput;
};

export const DEFAULT_SERVERS = ["nats://127.0.0.1:4222"];

function splitServers(value: string | string[] | undefined): string[] {
  const list = Array.isArray(value) ? value : (value ?? "").split(",");
  return list.map((s) => s.trim()).filter(Boolean);
}

export function parseServers(value: string | string[] | undefined): string[] {
  const servers = splitServers(value);
  return servers.length > 0 ? servers : [...DEFAULT_SERVERS];
}

export function serversForTransport(config: Pick<NatsConfig, "servers" | "wsServers" | "transport">): string[] {
  return config.transport === "ws" ? (config.wsServers ?? config.servers) : config.servers;
}

export function defaultConnectionName(): string {
  return `next-nats@${hostname()}:${process.pid}`;
}

function resolveTransport(value: NatsTransportInput | string, nextRuntime: string | undefined): NatsTransport {
  if (value === "tcp" || value === "ws") return value;
  if (value === "auto") {
    const bun = "Bun" in globalThis;
    return bun || nextRuntime === "edge" ? "ws" : "tcp";
  }
  throw invalidArgument("next-nats.config", "INVALID_TRANSPORT", `transport must be "auto", "tcp" or "ws", got "${value}"`);
}

function resolveSynadia(input: SynadiaInput | undefined): SynadiaRegion | undefined {
  if (input === undefined) return undefined;
  if (input === true) return DEFAULT_SYNADIA_REGION;
  const region = typeof input === "string" ? input : input.region;
  return region ? synadiaRegion(region) : DEFAULT_SYNADIA_REGION;
}

export function tlsFromEnv(env: Env): NatsTlsConfig | undefined {
  const tls: NatsTlsConfig = {
    caFile: envString(env, "NATS_CA"),
    certFile: envString(env, "NATS_CERT"),
    keyFile: envString(env, "NATS_KEY"),
    handshakeFirst: envBool(env, "NATS_TLS_FIRST"),
    rejectUnauthorized: envBool(env, "NATS_TLS_REJECT_UNAUTHORIZED"),
  };
  const required = envBool(env, "NATS_TLS") === true;
  const configured = Object.values(tls).some((v) => v !== undefined);
  return required || configured ? tls : undefined;
}

function build(input: NatsConfigInput, nextRuntime: string | undefined): NatsConfig {
  const transport = resolveTransport(input.transport ?? "auto", nextRuntime);
  const synadia = resolveSynadia(input.synadia);
  const preset = synadia ? synadiaServers(synadia) : undefined;
  const explicitServers = splitServers(input.servers);
  const explicitWsServers = splitServers(input.wsServers);
  const wsServers = explicitWsServers.length > 0 ? explicitWsServers : preset?.wsServers;
  const { jsDomain, jsApiPrefix } = input;
  if (jsDomain && jsApiPrefix) {
    throw invalidArgument("next-nats.config", "JS_DOMAIN_AND_API_PREFIX", "jsDomain and jsApiPrefix are mutually exclusive");
  }
  const streamMaxBytes =
    input.streamMaxBytes !== undefined ? byteSize(input.streamMaxBytes).toBytes() : synadia ? SYNADIA_DEFAULT_STREAM_MAX_BYTES : undefined;
  return {
    servers: explicitServers.length > 0 ? explicitServers : (preset?.servers ?? [...DEFAULT_SERVERS]),
    ...(wsServers && { wsServers }),
    transport,
    name: input.name || defaultConnectionName(),
    auth: input.auth ? normalizeAuth(input.auth) : { kind: "none" },
    ...(synadia && { synadia }),
    ...(jsDomain && { jsDomain }),
    ...(jsApiPrefix && { jsApiPrefix }),
    ...(streamMaxBytes !== undefined && { streamMaxBytes }),
    ...(input.tls && { tls: input.tls }),
    workers: input.workers ?? false,
    timeout: duration(input.timeout ?? 10_000).millis,
    maxReconnectAttempts: input.maxReconnectAttempts ?? -1,
    reconnectTimeWait: duration(input.reconnectTimeWait ?? 2_000).millis,
    drainTimeout: duration(input.drainTimeout ?? 10_000).millis,
  };
}

export function natsConfig(input: NatsConfigInput = {}): NatsConfig {
  return build(input, process.env.NEXT_RUNTIME);
}

const readTextFile = (path: string): string => readFileSync(path, "utf8");

export function natsConfigFromEnv(env: Env = process.env): NatsConfig {
  const input: NatsConfigInput = {
    servers: env.NATS_URL,
    wsServers: env.NATS_WS_SERVERS,
    transport: (env.NATS_TRANSPORT || "auto") as NatsTransportInput,
    name: env.NATS_NAME,
    auth: authFromEnv(env, readTextFile),
    synadia: envSynadia(env),
    jsDomain: envString(env, "NATS_JS_DOMAIN"),
    jsApiPrefix: envString(env, "NATS_JS_API_PREFIX"),
    streamMaxBytes: envBytes(env, "NATS_STREAM_MAX_BYTES"),
    tls: tlsFromEnv(env),
    workers: envBool(env, "NATS_WORKERS"),
    timeout: envMillis(env, "NATS_TIMEOUT"),
    maxReconnectAttempts: envInt(env, "NATS_MAX_RECONNECT_ATTEMPTS"),
    reconnectTimeWait: envMillis(env, "NATS_RECONNECT_TIME_WAIT"),
    drainTimeout: envMillis(env, "NATS_DRAIN_TIMEOUT"),
  };
  return build(input, env.NEXT_RUNTIME);
}

export { authFromEnv, decodeCreds, normalizeAuth, type NatsAuth, type NatsAuthInput } from "./auth.js";

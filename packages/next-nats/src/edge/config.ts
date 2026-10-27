import { authFromEnv, isFileAuth, normalizeAuth, type PortableAuth, type PortableAuthInput } from "../auth.js";
import { duration, type DurationInput } from "../duration.js";
import { envInt, envMillis, envString, envSynadia, type Env } from "../env.js";
import { invalidArgument } from "../errors.js";
import { DEFAULT_SYNADIA_REGION, synadiaRegion, synadiaServers } from "../synadia-region.js";

export interface EdgeNatsConfig {
  wsServers: string[];
  name: string;
  auth: PortableAuth;
  jsDomain?: string;
  jsApiPrefix?: string;
  timeout: number;
  maxReconnectAttempts: number;
  reconnectTimeWait: number;
}

export type EdgeNatsConfigInput = Partial<Omit<EdgeNatsConfig, "wsServers" | "auth" | "timeout" | "reconnectTimeWait">> & {
  timeout?: DurationInput;
  reconnectTimeWait?: DurationInput;
  wsServers?: string | string[];
  auth?: PortableAuthInput;
  synadia?: true | string | { region?: string };
};

function servers(value: string | string[] | undefined): string[] {
  const list = Array.isArray(value) ? value : (value ?? "").split(",");
  return list.map((s) => s.trim()).filter(Boolean);
}

function region(input: EdgeNatsConfigInput["synadia"]) {
  if (input === undefined) return undefined;
  const name = input === true ? undefined : typeof input === "string" ? input : input.region;
  return name ? synadiaRegion(name) : DEFAULT_SYNADIA_REGION;
}

export function edgeNatsConfig(input: EdgeNatsConfigInput = {}): EdgeNatsConfig {
  const synadia = region(input.synadia);
  const explicit = servers(input.wsServers);
  const wsServers = explicit.length > 0 ? explicit : synadia ? synadiaServers(synadia).wsServers : [];
  if (wsServers.length === 0) {
    throw invalidArgument(
      "next-nats.edge",
      "MISSING_WS_SERVERS",
      "wsServers is required in the Edge runtime: set it to a ws:// or wss:// URL (NATS_WS_SERVERS when read from the environment)",
    );
  }
  const { jsDomain, jsApiPrefix } = input;
  if (jsDomain && jsApiPrefix) {
    throw invalidArgument("next-nats.edge", "JS_DOMAIN_AND_API_PREFIX", "jsDomain and jsApiPrefix are mutually exclusive");
  }
  const auth = input.auth ? normalizeAuth(input.auth) : ({ kind: "none" } as const);
  if (isFileAuth(auth)) {
    throw invalidArgument("next-nats.edge", "UNSUPPORTED_AUTH", `${auth.kind} auth needs a file system: pass the contents inline in the Edge runtime`);
  }
  return {
    wsServers,
    name: input.name || "next-nats-edge",
    auth,
    ...(jsDomain && { jsDomain }),
    ...(jsApiPrefix && { jsApiPrefix }),
    timeout: duration(input.timeout ?? 10_000).millis,
    maxReconnectAttempts: input.maxReconnectAttempts ?? -1,
    reconnectTimeWait: duration(input.reconnectTimeWait ?? 2_000).millis,
  };
}

export function edgeNatsConfigFromEnv(env: Env = process.env): EdgeNatsConfig {
  const auth = authFromEnv(env);
  if (isFileAuth(auth)) {
    const key = auth.kind === "credsFile" ? "NATS_CREDS" : "NATS_NKEY";
    throw invalidArgument("next-nats.edge", "UNSUPPORTED_AUTH", `${key} points at a file, which needs a file system: use a data: or env:// value in the Edge runtime`);
  }
  return edgeNatsConfig({
    wsServers: env.NATS_WS_SERVERS,
    name: env.NATS_NAME,
    auth,
    synadia: envSynadia(env),
    jsDomain: envString(env, "NATS_JS_DOMAIN"),
    jsApiPrefix: envString(env, "NATS_JS_API_PREFIX"),
    timeout: envMillis(env, "NATS_TIMEOUT"),
    maxReconnectAttempts: envInt(env, "NATS_MAX_RECONNECT_ATTEMPTS"),
    reconnectTimeWait: envMillis(env, "NATS_RECONNECT_TIME_WAIT"),
  });
}

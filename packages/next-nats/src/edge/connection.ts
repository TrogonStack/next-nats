import { jetstream, type JetStreamClient } from "@nats-io/jetstream";
import { wsconnect, type NatsConnection } from "@nats-io/nats-core";
import { buildPortableAuthenticator } from "../authenticator.js";
import { edgeNatsConfig, edgeNatsConfigFromEnv, type EdgeNatsConfig, type EdgeNatsConfigInput } from "./config.js";

export interface EdgeNats {
  nc: NatsConnection;
  js: JetStreamClient;
}

interface EdgeStore {
  config?: EdgeNatsConfig;
  current?: EdgeNats;
  pending?: Promise<EdgeNats>;
}

const STORE_KEY = Symbol.for("@trogonstack/next-nats/edge");

function store(): EdgeStore {
  const g = globalThis as unknown as Record<symbol, EdgeStore | undefined>;
  return (g[STORE_KEY] ??= {});
}

export function configureEdgeNats(input: EdgeNatsConfigInput = {}): EdgeNatsConfig {
  const s = store();
  if (s.current || s.pending) {
    throw new Error("configureEdgeNats() must run before the first connection is opened");
  }
  s.config = edgeNatsConfig(input);
  return s.config;
}

export function getEdgeNatsConfig(): EdgeNatsConfig {
  const s = store();
  return (s.config ??= edgeNatsConfigFromEnv());
}

async function open(config: EdgeNatsConfig): Promise<EdgeNats> {
  const s = store();
  const nc = await wsconnect({
    servers: config.wsServers,
    name: config.name,
    authenticator: buildPortableAuthenticator(config.auth),
    timeout: config.timeout,
    maxReconnectAttempts: config.maxReconnectAttempts,
    reconnectTimeWait: config.reconnectTimeWait,
    waitOnFirstConnect: false,
  });
  const js = jetstream(nc, {
    ...(config.jsDomain && { domain: config.jsDomain }),
    ...(config.jsApiPrefix && { apiPrefix: config.jsApiPrefix }),
  });
  const nats = { nc, js };
  s.current = nats;
  void nc.closed().then(() => {
    if (s.current?.nc === nc) {
      s.current = undefined;
      s.pending = undefined;
    }
  });
  return nats;
}

export async function getEdgeNats(): Promise<EdgeNats> {
  const s = store();
  if (s.current && !s.current.nc.isClosed() && !s.current.nc.isDraining()) return s.current;
  if (!s.pending) {
    s.current = undefined;
    const pending = open(getEdgeNatsConfig());
    s.pending = pending;
    pending.catch(() => {
      if (s.pending === pending) s.pending = undefined;
    });
  }
  return s.pending;
}

export async function closeEdgeNats(): Promise<void> {
  const s = store();
  const current = s.current ?? (await s.pending?.catch(() => undefined));
  s.current = undefined;
  s.pending = undefined;
  await current?.nc.drain().catch(() => undefined);
}

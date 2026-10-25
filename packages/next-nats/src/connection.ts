import { readFileSync } from "node:fs";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  credsAuthenticator,
  nkeyAuthenticator,
  tokenAuthenticator,
  usernamePasswordAuthenticator,
  wsconnect,
  type Authenticator,
  type NatsConnection,
} from "@nats-io/nats-core";
import { Objm } from "@nats-io/obj";
import { connect as tcpConnect, type NodeConnectionOptions } from "@nats-io/transport-node";
import { decodeCreds, resolveConfig, type NatsAuth, type NatsConfig, type NatsConfigInput } from "./config.js";
import { bucketName, type BucketName } from "./values.js";

export interface Nats {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

export type NatsStatusEvent = { type: string; data?: unknown };
export type NatsStatusListener = (event: NatsStatusEvent) => void;
export type ShutdownHook = () => void | Promise<void>;

interface NatsStore {
  config?: NatsConfig;
  pending?: Promise<Nats>;
  current?: Nats;
  listeners: Set<NatsStatusListener>;
  shutdownHooks: Set<ShutdownHook>;
  signalsInstalled: boolean;
  closing?: Promise<void>;
  kv: Map<string, Promise<import("@nats-io/kv").KV>>;
}

const STORE_KEY = Symbol.for("next-nats.store");

function store(): NatsStore {
  const g = globalThis as unknown as Record<symbol, NatsStore | undefined>;
  return (g[STORE_KEY] ??= { listeners: new Set(), shutdownHooks: new Set(), signalsInstalled: false, kv: new Map() });
}

export function buildAuthenticator(auth: NatsAuth): Authenticator | undefined {
  switch (auth.kind) {
    case "none":
      return undefined;
    case "token":
      return tokenAuthenticator(auth.token);
    case "userpass":
      return usernamePasswordAuthenticator(auth.user, auth.pass);
    case "nkey":
      return nkeyAuthenticator(new TextEncoder().encode(auth.seed));
    case "creds": {
      const bytes = decodeCreds(auth.creds);
      return credsAuthenticator(bytes);
    }
    case "credsFile":
      return credsAuthenticator(() => new Uint8Array(readFileSync(auth.path)));
  }
}

export function buildConnectionOptions(config: NatsConfig): NodeConnectionOptions {
  const tls = config.tls
    ? {
        ...(config.tls.caFile && { caFile: config.tls.caFile }),
        ...(config.tls.certFile && { certFile: config.tls.certFile }),
        ...(config.tls.keyFile && { keyFile: config.tls.keyFile }),
        ...(config.tls.handshakeFirst !== undefined && { handshakeFirst: config.tls.handshakeFirst }),
        ...(config.tls.rejectUnauthorized !== undefined && { rejectUnauthorized: config.tls.rejectUnauthorized }),
      }
    : undefined;
  return {
    servers: config.servers,
    name: config.name,
    authenticator: buildAuthenticator(config.auth),
    tls,
    timeout: config.timeout,
    maxReconnectAttempts: config.maxReconnectAttempts,
    reconnectTimeWait: config.reconnectTimeWait,
    waitOnFirstConnect: false,
  };
}

export function configureNats(input: NatsConfigInput = {}): NatsConfig {
  const s = store();
  if (s.current || s.pending) {
    throw new Error("configureNats() must run before the first connection is opened");
  }
  s.config = resolveConfig(input);
  return s.config;
}

export function getNatsConfig(): NatsConfig {
  const s = store();
  return (s.config ??= resolveConfig());
}

async function open(config: NatsConfig): Promise<Nats> {
  const opts = buildConnectionOptions(config);
  const nc = config.transport === "ws" ? await wsconnect(opts) : await tcpConnect(opts);
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const s = store();
  const nats: Nats = { nc, js, jsm };
  s.current = nats;
  void watchStatus(nc);
  void nc.closed().then(() => {
    if (s.current?.nc === nc) {
      s.current = undefined;
      s.pending = undefined;
    }
  });
  installSignalHandlers();
  return nats;
}

async function watchStatus(nc: NatsConnection): Promise<void> {
  for await (const status of nc.status()) {
    for (const listener of store().listeners) {
      try {
        listener({ type: status.type, data: "data" in status ? status.data : undefined });
      } catch {
        continue;
      }
    }
  }
}

export function connectNats(input?: NatsConfigInput): Promise<Nats> {
  const s = store();
  if (input) {
    if (s.current || s.pending) throw new Error("connectNats(config) called after a connection was opened");
    s.config = resolveConfig(input);
  }
  if (!s.pending) {
    const pending = open(getNatsConfig());
    s.pending = pending;
    pending.catch(() => {
      if (s.pending === pending) s.pending = undefined;
    });
  }
  return s.pending;
}

export function getNats(): Promise<Nats> {
  return connectNats();
}

export function peekNats(): Nats | undefined {
  return store().current;
}

export async function getNc(): Promise<NatsConnection> {
  return (await getNats()).nc;
}

export async function getJs(): Promise<JetStreamClient> {
  return (await getNats()).js;
}

export async function getJsm(): Promise<JetStreamManager> {
  return (await getNats()).jsm;
}

export async function getKvm(): Promise<Kvm> {
  return new Kvm((await getNats()).js);
}

export async function getObjm(): Promise<Objm> {
  return new Objm((await getNats()).js);
}

export interface OpenKvOptions {
  create?: boolean;
  history?: number;
  ttl?: number;
  markerTTL?: number;
  maxBytes?: number;
  replicas?: number;
  description?: string;
}

export async function openKv(bucket: BucketName | string, opts: OpenKvOptions = {}) {
  const kvCache = store().kv;
  const name = bucketName(bucket);
  const key = `${name}:${opts.create ?? true}`;
  let kv = kvCache.get(key);
  if (!kv) {
    const { create = true, ...kvOpts } = opts;
    const kvm = await getKvm();
    kv = create ? kvm.create(name, kvOpts) : kvm.open(name);
    kvCache.set(key, kv);
    kv.catch(() => kvCache.delete(key));
  }
  return kv;
}

export function onNatsStatus(listener: NatsStatusListener): () => void {
  const { listeners } = store();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onNatsShutdown(hook: ShutdownHook): () => void {
  const { shutdownHooks } = store();
  shutdownHooks.add(hook);
  return () => shutdownHooks.delete(hook);
}

export function closeNats(): Promise<void> {
  const s = store();
  if (s.closing) return s.closing;
  const closing = (async () => {
    for (const hook of [...s.shutdownHooks]) {
      try {
        await hook();
      } catch {
        continue;
      }
    }
    const current = s.current ?? (await s.pending?.catch(() => undefined));
    if (current && !current.nc.isClosed()) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, getNatsConfig().drainTimeout).unref());
      await Promise.race([current.nc.drain().catch(() => undefined), timeout]);
      if (!current.nc.isClosed()) await current.nc.close();
    }
    s.current = undefined;
    s.pending = undefined;
    s.kv.clear();
  })().finally(() => {
    s.closing = undefined;
  });
  s.closing = closing;
  return closing;
}

function installSignalHandlers(): void {
  const s = store();
  if (s.signalsInstalled) return;
  s.signalsInstalled = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = () => {
      process.off(signal, handler);
      void closeNats().finally(() => {
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
    };
    process.on(signal, handler);
  }
}

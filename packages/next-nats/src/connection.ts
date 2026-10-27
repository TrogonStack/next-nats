import { readFileSync } from "node:fs";
import {
  jetstream,
  jetstreamManager,
  JetStreamApiCodes,
  JetStreamApiError,
  type JetStreamClient,
  type JetStreamManager,
  type JetStreamOptions,
} from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  AuthorizationError,
  credsAuthenticator,
  nkeyAuthenticator,
  nanos,
  UserAuthenticationExpiredError,
  wsconnect,
  type Authenticator,
  type NatsConnection,
} from "@nats-io/nats-core";
import type { Secret } from "./secret.js";
import { Objm } from "@nats-io/obj";
import { connect as tcpConnect, type NodeConnectionOptions } from "@nats-io/transport-node";
import { buildPortableAuthenticator, decodeCreds, withToken } from "./auth.js";
import { natsConfig, natsConfigFromEnv, serversForTransport, type NatsAuth, type NatsConfig, type NatsConfigInput } from "./config.js";
import { bucketName, type BucketName } from "./values.js";
import { failedPrecondition } from "./errors.js";
import { assessExpiry, CredentialsExpiredError, jwtExpiry, jwtFromCreds } from "./jwt.js";
import { emitLifecycle } from "./lifecycle.js";
import { getLogger } from "./logger.js";

export {
  onNatsConnectError,
  onNatsDisconnect,
  onNatsReconnect,
  type NatsConnectErrorEvent,
  type NatsDisconnectEvent,
  type NatsReconnectEvent,
} from "./lifecycle.js";

export interface Nats {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

export type NatsStatusEvent = { type: string; data?: unknown; error?: Error };
export type NatsStatusListener = (event: NatsStatusEvent) => void;
export type ConnectionPhase = "idle" | "connected" | "reconnecting" | "closed";

export interface ConnectionState {
  phase: ConnectionPhase;
  since: number;
  shuttingDown: boolean;
  initializing: boolean;
}

export type ShutdownHook = () => void | Promise<void>;
export type ShutdownStage = "agents" | "consumers" | "default";

const SHUTDOWN_STAGES: readonly ShutdownStage[] = ["agents", "consumers", "default"];

interface NatsStore {
  config?: NatsConfig;
  pending?: Promise<Nats>;
  current?: Nats;
  listeners: Set<NatsStatusListener>;
  shutdownHooks: Map<ShutdownHook, ShutdownStage>;
  signalsInstalled: boolean;
  closing?: Promise<void>;
  phase: ConnectionPhase;
  phaseSince: number;
  shuttingDown: boolean;
  initializing: number;
  kv: Map<string, Promise<import("@nats-io/kv").KV>>;
  obj: Map<string, Promise<import("@nats-io/obj").ObjectStore>>;
  jsProbe: WeakMap<NatsConnection, Promise<boolean>>;
}

const STORE_KEY = Symbol.for("next-nats.store");

function setPhase(s: NatsStore, phase: ConnectionPhase): void {
  if (s.phase === phase) return;
  s.phase = phase;
  s.phaseSince = Date.now();
}

function store(): NatsStore {
  const g = globalThis as unknown as Record<symbol, NatsStore | undefined>;
  return (g[STORE_KEY] ??= {
    listeners: new Set(),
    shutdownHooks: new Map(),
    signalsInstalled: false,
    phase: "idle",
    phaseSince: Date.now(),
    shuttingDown: false,
    initializing: 0,
    kv: new Map(),
    obj: new Map(),
    jsProbe: new WeakMap(),
  });
}

export function buildAuthenticator(auth: NatsAuth): Authenticator | undefined {
  switch (auth.kind) {
    case "none":
      return undefined;
    case "credsFile":
      return withToken(auth, credsAuthenticator(() => new Uint8Array(readFileSync(auth.path))));
    case "nkeyFile":
      return withToken(auth, nkeyAuthenticator(() => new TextEncoder().encode(readFileSync(auth.path, "utf8").trim())));
    default:
      return buildPortableAuthenticator(auth);
  }
}

export function authMode(config: Pick<NatsConfig, "auth">): string {
  return config.auth.kind;
}

function authExpiry(auth: NatsAuth): Date | undefined {
  switch (auth.kind) {
    case "creds":
      return jwtExpiry(jwtFromCreds(new TextDecoder().decode(decodeCreds(auth.creds))) ?? "");
    case "credsFile":
      return jwtExpiry(jwtFromCreds(readFileSync(auth.path, "utf8")) ?? "");
    case "jwt":
    case "bearer":
      return jwtExpiry(auth.userJwt);
    default:
      return undefined;
  }
}

function checkAuthExpiry(auth: NatsAuth): void {
  const verdict = assessExpiry(`NATS ${auth.kind}`, authExpiry(auth));
  if (verdict.status === "expiring") {
    getLogger().warning(`NATS ${auth.kind} credentials expire in ${Math.round(verdict.remainingMs / 60_000)} minutes`, {
      expiresAt: verdict.expiresAt.toISOString(),
    });
  }
}

export function isAuthError(error: unknown): boolean {
  return error instanceof AuthorizationError || error instanceof UserAuthenticationExpiredError || error instanceof CredentialsExpiredError;
}

const URL_USERINFO = /(:\/\/)[^/@\s]*@/g;

function reportAuthError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  getLogger().error(`AUTH ERROR: ${message.replace(URL_USERINFO, "$1***@")}`, {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
}

function jetStreamOptions(config: NatsConfig): JetStreamOptions {
  return {
    ...(config.jsDomain && { domain: config.jsDomain }),
    ...(config.jsApiPrefix && { apiPrefix: config.jsApiPrefix }),
  };
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
    servers: serversForTransport(config),
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
    throw failedPrecondition("next-nats.connection", "ALREADY_CONNECTED", "configureNats() must run before the first connection is opened");
  }
  s.config = natsConfig(input);
  return s.config;
}

export function getNatsConfig(): NatsConfig {
  const s = store();
  return (s.config ??= natsConfigFromEnv());
}

async function open(config: NatsConfig): Promise<Nats> {
  const s = store();
  try {
    checkAuthExpiry(config.auth);
    const opts = buildConnectionOptions(config);
    const nc = config.transport === "ws" ? await wsconnect(opts) : await tcpConnect(opts);
    const jsOpts = jetStreamOptions(config);
    const js = jetstream(nc, jsOpts);
    const jsm = await jetstreamManager(nc, { ...jsOpts, checkAPI: false });
    const nats: Nats = { nc, js, jsm };
    s.current = nats;
    s.shuttingDown = false;
    setPhase(s, "connected");
    void watchStatus(nc);
    void nc.closed().then(() => {
      if (s.current?.nc === nc) {
        s.current = undefined;
        s.pending = undefined;
        setPhase(s, "closed");
      }
    });
    installSignalHandlers();
    return nats;
  } catch (error) {
    const auth = isAuthError(error);
    if (auth) reportAuthError(error);
    emitLifecycle("connectError", { error: error instanceof Error ? error : new Error(String(error)), kind: auth ? "auth" : "initial" });
    throw error;
  }
}

async function watchStatus(nc: NatsConnection): Promise<void> {
  let outageSince: number | undefined;
  for await (const status of nc.status()) {
    const s = store();
    if (s.current?.nc === nc) {
      if (status.type === "disconnect" || status.type === "reconnecting") setPhase(s, "reconnecting");
      else if (status.type === "reconnect") setPhase(s, "connected");
    }
    if (status.type === "disconnect" && outageSince === undefined) {
      outageSince = Date.now();
      emitLifecycle("disconnect", { server: status.server });
    } else if (status.type === "reconnect" && outageSince !== undefined) {
      emitLifecycle("reconnect", { server: status.server, downtimeMs: Date.now() - outageSince });
      outageSince = undefined;
    } else if (status.type === "error" && isAuthError(status.error)) {
      reportAuthError(status.error);
      emitLifecycle("connectError", { error: status.error, kind: "auth" });
    }
    for (const listener of store().listeners) {
      try {
        listener({ type: status.type, data: "data" in status ? status.data : undefined, ...(status.type === "error" && { error: status.error }) });
      } catch {
        continue;
      }
    }
  }
}

export function connectNats(input?: NatsConfigInput): Promise<Nats> {
  const s = store();
  if (input) {
    if (s.current || s.pending) throw failedPrecondition("next-nats.connection", "ALREADY_CONNECTED", "connectNats(config) called after a connection was opened");
    s.config = natsConfig(input);
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

export function getConnectionState(): ConnectionState {
  const s = store();
  return { phase: s.phase, since: s.phaseSince, shuttingDown: s.shuttingDown, initializing: s.initializing > 0 };
}

export async function trackInitialization<T>(fn: () => Promise<T>): Promise<T> {
  const s = store();
  s.initializing += 1;
  try {
    return await fn();
  } finally {
    s.initializing -= 1;
  }
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

function isJetStreamDisabled(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "JetStreamNotEnabled") ||
    (error instanceof JetStreamApiError && error.code === JetStreamApiCodes.JetStreamNotEnabledForAccount)
  );
}

export async function getJsIfAvailable(): Promise<JetStreamClient | undefined> {
  const { nc, js, jsm } = await getNats();
  const probes = store().jsProbe;
  let probe = probes.get(nc);
  if (!probe) {
    probe = jsm.getAccountInfo().then(
      () => true,
      (error: unknown) => {
        if (isJetStreamDisabled(error)) return false;
        probes.delete(nc);
        throw error;
      },
    );
    probes.set(nc, probe);
  }
  return (await probe) ? js : undefined;
}

export function defaultMaxBytes(): number | undefined {
  return getNatsConfig().streamMaxBytes;
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
  markerTtl?: number;
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
    const { create = true, markerTtl, maxBytes = defaultMaxBytes(), ...rest } = opts;
    const kvOpts = { ...rest, ...(markerTtl !== undefined && { markerTTL: markerTtl }), ...(maxBytes !== undefined && { max_bytes: maxBytes }) };
    const kvm = await getKvm();
    kv = create ? kvm.create(name, kvOpts) : kvm.open(name);
    kvCache.set(key, kv);
    kv.catch(() => kvCache.delete(key));
  }
  return kv;
}

export interface OpenObjOptions {
  create?: boolean;
  ttl?: number;
  maxBytes?: number;
  replicas?: number;
  description?: string;
  compression?: boolean;
}

export async function openObj(bucket: BucketName | string, opts: OpenObjOptions = {}) {
  const objCache = store().obj;
  const name = bucketName(bucket);
  const key = `${name}:${opts.create ?? true}`;
  let obj = objCache.get(key);
  if (!obj) {
    const { create = true, ttl, maxBytes = defaultMaxBytes(), ...rest } = opts;
    const objOpts = { ...rest, ...(ttl !== undefined && { ttl: nanos(ttl) }), ...(maxBytes !== undefined && { max_bytes: maxBytes }) };
    const objm = await getObjm();
    obj = create ? objm.create(name, objOpts) : objm.open(name);
    objCache.set(key, obj);
    obj.catch(() => objCache.delete(key));
  }
  return obj;
}

export function onNatsStatus(listener: NatsStatusListener): () => void {
  const { listeners } = store();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onNatsShutdown(hook: ShutdownHook, options: { stage?: ShutdownStage } = {}): () => void {
  const { shutdownHooks } = store();
  shutdownHooks.set(hook, options.stage ?? "default");
  return () => shutdownHooks.delete(hook);
}

export function closeNats(): Promise<void> {
  const s = store();
  if (s.closing) return s.closing;
  s.shuttingDown = true;
  const closing = (async () => {
    for (const stage of SHUTDOWN_STAGES) {
      for (const [hook, hookStage] of [...s.shutdownHooks]) {
        if (hookStage !== stage) continue;
        try {
          await hook();
        } catch {
          continue;
        }
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
    setPhase(s, "closed");
    s.kv.clear();
    s.obj.clear();
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

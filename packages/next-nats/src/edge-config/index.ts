import "server-only";
import { createHash } from "node:crypto";
import type { KV, KvWatchEntry } from "@nats-io/kv";
import { codec } from "../codec.js";
import { Code, SpecError } from "../errors.js";
import { onNatsShutdown, openKv } from "../connection.js";
import { decodeKey, encodeKey } from "../kv/key.js";
import { KvStore, type RawOp } from "../kv/store.js";

export type EdgeConfigValue = string | number | boolean | null | { [x: string]: EdgeConfigValue } | EdgeConfigValue[];
export type EdgeConfigItems = Record<string, EdgeConfigValue>;

export interface EmbeddedEdgeConfig {
  digest: string;
  items: Record<string, EdgeConfigValue>;
}

export type Connection = {
  baseUrl: string;
  id: string;
  token: string;
  version: string;
  type: "vercel";
} | {
  baseUrl: string;
  id: string;
  token: string;
  version: string;
  type: "external";
};

export interface EdgeConfigFunctionsOptions {
  consistentRead?: boolean;
}

export interface EdgeConfigClientOptions {
  staleIfError?: number | false;
  disableDevelopmentCache?: boolean;
  cache?: "no-store" | "force-cache";
}

export interface EdgeConfigClient {
  connection: Connection;
  get: <T = EdgeConfigValue>(key: string, options?: EdgeConfigFunctionsOptions) => Promise<T | undefined>;
  getAll: <T = EdgeConfigItems>(keys?: (keyof T)[], options?: EdgeConfigFunctionsOptions) => Promise<T>;
  has: (key: string, options?: EdgeConfigFunctionsOptions) => Promise<boolean>;
  digest: (options?: EdgeConfigFunctionsOptions) => Promise<string>;
  close: () => Promise<void>;
}

export type EdgeConfigItemOperation =
  | { operation: "create" | "update" | "upsert"; key: string; value: EdgeConfigValue }
  | { operation: "delete"; key: string };

export interface UpdateEdgeConfigItemsOptions {
  items: EdgeConfigItemOperation[];
}

export class EdgeConfigError extends SpecError {
  constructor(message: string, spec: { code?: Code; reason?: string } = {}) {
    super({
      code: Code.INVALID_ARGUMENT,
      reason: "INVALID_OPERATION",
      ...spec,
      domain: "next-nats.edge-config",
      message,
    });
    this.name = "EdgeConfigError";
  }
}

class Mirror {
  private readonly items = new Map<string, EdgeConfigValue>();
  private cachedDigest?: string;
  private readonly ready: Promise<void>;
  private iter?: { stop(): void };

  constructor(private readonly kv: KV) {
    this.ready = this.start();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private async start(): Promise<void> {
    let signal!: () => void;
    const caughtUp = new Promise<void>((resolve) => (signal = resolve));
    const iter = await this.kv.watch({ include: "" });
    this.iter = iter;
    const empty = (await this.collectKeys()).length === 0;
    if (empty) signal();
    void (async () => {
      try {
        for await (const entry of iter) {
          this.apply(entry);
          if (entry.delta === 0 || entry.isUpdate) signal();
        }
      } catch {
        return;
      } finally {
        signal();
      }
    })();
    await caughtUp;
  }

  private async collectKeys(): Promise<string[]> {
    const out: string[] = [];
    for await (const k of await this.kv.keys()) out.push(k);
    return out;
  }

  private apply(entry: KvWatchEntry): void {
    const key = decodeKey(entry.key);
    if (entry.operation === "PUT") this.items.set(key, entry.json<EdgeConfigValue>());
    else this.items.delete(key);
    this.cachedDigest = undefined;
  }

  get(key: string): EdgeConfigValue | undefined {
    return this.items.get(key);
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  all(): EdgeConfigItems {
    return Object.fromEntries(this.items);
  }

  digest(): string {
    this.cachedDigest ??= digestOf(this.all());
    return this.cachedDigest;
  }

  stop(): void {
    this.iter?.stop();
  }
}

function digestOf(items: EdgeConfigItems): string {
  const sorted = Object.keys(items)
    .sort()
    .map((k) => [k, items[k]]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 32);
}

async function readAll(kv: KV): Promise<EdgeConfigItems> {
  const out: EdgeConfigItems = {};
  const keys: string[] = [];
  for await (const k of await kv.keys()) keys.push(k);
  await Promise.all(
    keys.map(async (k) => {
      const entry = await kv.get(k);
      if (entry && entry.operation === "PUT") out[decodeKey(k)] = entry.json<EdgeConfigValue>();
    }),
  );
  return out;
}

const MIRRORS_KEY = Symbol.for("next-nats.edge-config.mirrors");

function mirrors(): Map<string, Promise<Mirror>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<Mirror>> | undefined>;
  return (g[MIRRORS_KEY] ??= new Map());
}

function mirrorFor(bucket: string): Promise<Mirror> {
  const all = mirrors();
  let m = all.get(bucket);
  if (!m) {
    m = (async () => {
      const kv = await openKv(bucket);
      const mirror = new Mirror(kv);
      onNatsShutdown(() => {
        mirror.stop();
        all.delete(bucket);
      });
      await mirror.whenReady();
      return mirror;
    })();
    all.set(bucket, m);
    m.catch(() => all.delete(bucket));
  }
  return m;
}

const DEFAULT_BUCKET = "edge-config";
const SCHEME = "edge-config:";

function defaultConnectionString(): string {
  return process.env.EDGE_CONFIG ?? `${SCHEME}id=${process.env.NEXT_NATS_EDGE_CONFIG_BUCKET ?? DEFAULT_BUCKET}`;
}

function fromVercelUrl(text: string): Connection | null {
  try {
    const url = new URL(text);
    if (url.host !== "edge-config.vercel.com" || url.protocol !== "https:" || !url.pathname.startsWith("/ecfg")) return null;
    const id = url.pathname.split("/")[1];
    const token = url.searchParams.get("token");
    if (!id || !token) return null;
    return { type: "vercel", baseUrl: `https://edge-config.vercel.com/${id}`, id, version: "1", token };
  } catch {
    return null;
  }
}

function fromQueryParams(text: string): Connection | null {
  if (!text.startsWith(SCHEME)) return null;
  const params = new URLSearchParams(text.slice(SCHEME.length));
  const id = params.get("id");
  const token = params.get("token");
  if (!id || !token) return null;
  return { type: "vercel", baseUrl: `https://edge-config.vercel.com/${id}`, id, version: "1", token };
}

function fromExternalUrl(text: string): Connection | null {
  try {
    const url = new URL(text);
    let id = url.searchParams.get("id");
    const token = url.searchParams.get("token");
    const version = url.searchParams.get("version") || "1";
    if (!id || url.pathname.startsWith("/ecfg_")) id = url.pathname.split("/")[1] || null;
    if (!id || !token) return null;
    url.search = "";
    return { type: "external", baseUrl: url.toString(), id, token, version };
  } catch {
    return null;
  }
}

function fromBucketId(text: string): Connection | null {
  if (!text.startsWith(SCHEME)) return null;
  const params = new URLSearchParams(text.slice(SCHEME.length));
  const id = params.get("id");
  if (!id) return null;
  return { type: "external", baseUrl: `${SCHEME}${id}`, id, token: "", version: params.get("version") || "1" };
}

export function parseConnectionString(connectionString: string): Connection | null {
  return fromQueryParams(connectionString) ?? fromVercelUrl(connectionString) ?? fromExternalUrl(connectionString) ?? fromBucketId(connectionString);
}

function assertIsKey(key: unknown): asserts key is string {
  if (typeof key !== "string") throw new Error("@vercel/edge-config: Expected key to be a string");
}

function assertIsKeys(keys: unknown): asserts keys is string[] {
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
    throw new Error("@vercel/edge-config: Expected keys to be an array of string");
  }
}

export function clone<T = EdgeConfigValue>(edgeConfigValue: T): T {
  return JSON.parse(JSON.stringify(edgeConfigValue)) as T;
}

export function setTracerProvider(_tracer: unknown): void {}

export function createClient(connectionString: string | undefined, _options: EdgeConfigClientOptions = {}): EdgeConfigClient {
  if (!connectionString) throw new Error("@vercel/edge-config: No connection string provided");
  const connection = parseConnectionString(connectionString);
  if (!connection) throw new Error("@vercel/edge-config: Invalid connection string provided");
  const bucket = connection.id;
  return {
    connection,
    async get<T = EdgeConfigValue>(key: string, opts?: EdgeConfigFunctionsOptions) {
      assertIsKey(key);
      if (key.trim() === "") return undefined;
      if (opts?.consistentRead) {
        const entry = await (await openKv(bucket)).get(encodeKey(key));
        return entry && entry.operation === "PUT" ? entry.json<T>() : undefined;
      }
      const value = (await mirrorFor(bucket)).get(key);
      return value === undefined ? undefined : (clone(value) as T);
    },
    async getAll<T = EdgeConfigItems>(keys?: (keyof T)[], opts?: EdgeConfigFunctionsOptions) {
      if (keys) assertIsKeys(keys);
      const all = opts?.consistentRead ? await readAll(await openKv(bucket)) : (await mirrorFor(bucket)).all();
      if (!keys) return clone(all) as T;
      return clone(Object.fromEntries(keys.filter((k) => String(k) in all).map((k) => [k, all[String(k)]]))) as T;
    },
    async has(key: string, opts?: EdgeConfigFunctionsOptions) {
      assertIsKey(key);
      if (key.trim() === "") return false;
      if (opts?.consistentRead) {
        const entry = await (await openKv(bucket)).get(encodeKey(key));
        return entry !== null && entry.operation === "PUT";
      }
      return (await mirrorFor(bucket)).has(key);
    },
    async digest(opts?: EdgeConfigFunctionsOptions) {
      if (opts?.consistentRead) return digestOf(await readAll(await openKv(bucket)));
      return (await mirrorFor(bucket)).digest();
    },
    async close() {
      const m = mirrors().get(bucket);
      if (!m) return;
      mirrors().delete(bucket);
      (await m.catch(() => undefined))?.stop();
    },
  };
}

let defaultClient: EdgeConfigClient | undefined;

function client(): EdgeConfigClient {
  return (defaultClient ??= createClient(defaultConnectionString()));
}

export const get: EdgeConfigClient["get"] = (...args) => client().get(...args);
export const getAll: EdgeConfigClient["getAll"] = (...args) => client().getAll(...args);
export const has: EdgeConfigClient["has"] = (...args) => client().has(...args);
export const digest: EdgeConfigClient["digest"] = (...args) => client().digest(...args);

const ITEM_KEY = /^[A-Za-z0-9_-]{1,256}$/;

const MAX_ATTEMPTS = 100;

interface Observation {
  rev: number;
  exists: boolean;
}

async function plan(kv: KV, items: EdgeConfigItemOperation[]): Promise<RawOp[]> {
  const observed = new Map<string, Observation>();
  const staged = new Map<string, Uint8Array | null>();
  const present = new Map<string, boolean>();
  for (const item of items) {
    if (!ITEM_KEY.test(item.key)) {
      throw new EdgeConfigError(`Invalid item key "${item.key}"`, { reason: "INVALID_KEY" });
    }
    if (!observed.has(item.key)) {
      const entry = await kv.get(encodeKey(item.key));
      const seen = { rev: entry?.revision ?? 0, exists: entry !== null && entry.operation === "PUT" };
      observed.set(item.key, seen);
      present.set(item.key, seen.exists);
    }
    const exists = present.get(item.key)!;
    if (item.operation === "create" && exists) {
      throw new EdgeConfigError(`Item "${item.key}" already exists`, { code: Code.ALREADY_EXISTS, reason: "ITEM_EXISTS" });
    }
    if ((item.operation === "update" || item.operation === "delete") && !exists) {
      throw new EdgeConfigError(`Cannot ${item.operation} missing item "${item.key}"`, { code: Code.NOT_FOUND, reason: "ITEM_NOT_FOUND" });
    }
    present.set(item.key, item.operation !== "delete");
    staged.set(item.key, item.operation === "delete" ? null : codec.encodeJson(item.value));
  }
  return [...staged].map(([key, body]) => ({ key, body, expected: observed.get(key)!.rev }));
}

export async function updateEdgeConfigItems(
  connectionString: string | undefined,
  { items }: UpdateEdgeConfigItemsOptions,
): Promise<{ status: "ok" }> {
  const connection = parseConnectionString(connectionString ?? defaultConnectionString());
  if (!connection) throw new Error("@vercel/edge-config: Invalid connection string provided");
  const kv = await openKv(connection.id);
  const store = new KvStore({ bucket: connection.id });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ops = await plan(kv, items);
    if (ops.length === 0 || (await store.batch(ops))) return { status: "ok" };
    if (attempt > 2) await new Promise((r) => setTimeout(r, Math.random() * Math.min(5 * attempt, 50)));
  }
  throw new EdgeConfigError("Edge config items changed concurrently", { code: Code.ABORTED, reason: "CONCURRENT_UPDATE" });
}


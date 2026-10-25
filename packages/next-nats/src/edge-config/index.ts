import "server-only";
import { createHash } from "node:crypto";
import { JetStreamApiCodes, JetStreamApiError } from "@nats-io/jetstream";
import type { KV, KvWatchEntry } from "@nats-io/kv";
import { codec } from "../codec.js";
import { Code, SpecError } from "../errors.js";
import { onNatsShutdown, openKv } from "../connection.js";
import { decodeKey, encodeKey } from "../kv/key.js";
import { isConflict } from "../kv/store.js";

export type EdgeConfigValue = string | number | boolean | null | { [x: string]: EdgeConfigValue } | EdgeConfigValue[];
export type EdgeConfigItems = Record<string, EdgeConfigValue>;

export interface EdgeConfigFunctionsOptions {
  consistentRead?: boolean;
}

export interface EdgeConfigClient {
  readonly bucket: string;
  get<T = EdgeConfigValue>(key: string, options?: EdgeConfigFunctionsOptions): Promise<T | undefined>;
  getAll<T = EdgeConfigItems>(keys?: (keyof T)[], options?: EdgeConfigFunctionsOptions): Promise<T>;
  has(key: string, options?: EdgeConfigFunctionsOptions): Promise<boolean>;
  digest(options?: EdgeConfigFunctionsOptions): Promise<string>;
  close(): Promise<void>;
}

export interface EdgeConfigClientOptions {
  bucket?: string;
}

export type EdgeConfigItemOperation =
  | { operation: "create" | "update" | "upsert"; key: string; value: EdgeConfigValue }
  | { operation: "delete"; key: string };

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

const DEFAULT_BUCKET = "edge-config";

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

export function createClient(options: EdgeConfigClientOptions = {}): EdgeConfigClient {
  const bucket = options.bucket ?? process.env.NEXT_NATS_EDGE_CONFIG_BUCKET ?? DEFAULT_BUCKET;
  return {
    bucket,
    async get<T = EdgeConfigValue>(key: string, opts?: EdgeConfigFunctionsOptions) {
      if (opts?.consistentRead) {
        const entry = await (await openKv(bucket)).get(encodeKey(key));
        return entry && entry.operation === "PUT" ? entry.json<T>() : undefined;
      }
      return (await mirrorFor(bucket)).get(key) as T | undefined;
    },
    async getAll<T = EdgeConfigItems>(keys?: (keyof T)[], opts?: EdgeConfigFunctionsOptions) {
      const all = opts?.consistentRead ? await readAll(await openKv(bucket)) : (await mirrorFor(bucket)).all();
      if (!keys) return all as T;
      return Object.fromEntries(keys.filter((k) => String(k) in all).map((k) => [k, all[String(k)]])) as T;
    },
    async has(key: string, opts?: EdgeConfigFunctionsOptions) {
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
  return (defaultClient ??= createClient());
}

export const get = <T = EdgeConfigValue>(key: string, options?: EdgeConfigFunctionsOptions) => client().get<T>(key, options);
export const getAll = <T = EdgeConfigItems>(keys?: (keyof T)[], options?: EdgeConfigFunctionsOptions) =>
  client().getAll<T>(keys, options);
export const has = (key: string, options?: EdgeConfigFunctionsOptions) => client().has(key, options);
export const digest = (options?: EdgeConfigFunctionsOptions) => client().digest(options);

export async function setEdgeConfigItems(
  items: EdgeConfigItemOperation[],
  options: EdgeConfigClientOptions = {},
): Promise<void> {
  const bucket = options.bucket ?? process.env.NEXT_NATS_EDGE_CONFIG_BUCKET ?? DEFAULT_BUCKET;
  const kv = await openKv(bucket);
  for (const item of items) {
    const key = encodeKey(item.key);
    if (item.operation === "delete") {
      const entry = await kv.get(key);
      if (!entry || entry.operation !== "PUT") throw new EdgeConfigError(`Cannot delete missing item "${item.key}"`, { code: Code.NOT_FOUND, reason: "ITEM_NOT_FOUND" });
      await kv.delete(key);
      continue;
    }
    const data = codec.encodeJson(item.value);
    if (item.operation === "upsert") {
      await kv.put(key, data);
      continue;
    }
    if (item.operation === "create") {
      try {
        await kv.create(key, data);
      } catch (err) {
        if (err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamWrongLastSequence) {
          throw new EdgeConfigError(`Item "${item.key}" already exists`, { code: Code.ALREADY_EXISTS, reason: "ITEM_EXISTS" });
        }
        throw err;
      }
      continue;
    }
    const entry = await kv.get(key);
    if (!entry || entry.operation !== "PUT") throw new EdgeConfigError(`Cannot update missing item "${item.key}"`, { code: Code.NOT_FOUND, reason: "ITEM_NOT_FOUND" });
    try {
      await kv.update(key, data, entry.revision);
    } catch (err) {
      if (isConflict(err)) throw new EdgeConfigError(`Item "${item.key}" changed concurrently`, { code: Code.ABORTED, reason: "CONCURRENT_UPDATE" });
      throw err;
    }
  }
}

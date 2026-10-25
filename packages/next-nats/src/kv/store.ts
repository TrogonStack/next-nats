import "server-only";
import { JetStreamApiCodes, JetStreamApiError } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { getJs, openKv } from "../connection.js";
import { Code, SpecError } from "../errors.js";
import { decodeKey, encodeKey } from "./key.js";

export type RecordKind = "s" | "h";

export interface KvRecord {
  t: RecordKind;
  v: unknown;
  x?: number;
}

export interface KvStoreOptions {
  bucket: string;
  history?: number;
  maxBytes?: number;
  replicas?: number;
  markerTtl?: number;
  maxRetries?: number;
}

interface Handle {
  kv: KV;
  nativeTtl: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class KvError extends SpecError {
  constructor(
    readonly code: string,
    message: string,
    spec: { code?: Code; reason?: string } = {},
  ) {
    super({
      code: code === "WRONGTYPE" ? Code.FAILED_PRECONDITION : Code.INVALID_ARGUMENT,
      reason: code === "WRONGTYPE" ? "WRONG_TYPE" : "INVALID_COMMAND",
      ...spec,
      domain: "next-nats.kv",
      message,
      legacyMessage: `${code} ${message}`,
    });
    this.name = "KvError";
  }
}

export function isConflict(err: unknown): boolean {
  return (
    err instanceof JetStreamApiError &&
    (err.code === JetStreamApiCodes.StreamWrongLastSequence ||
      err.code === JetStreamApiCodes.StreamWrongLastSequenceUnknown)
  );
}

export class KvStore {
  readonly bucket: string;
  readonly maxRetries: number;
  private handle?: Promise<Handle>;

  constructor(private readonly options: KvStoreOptions) {
    this.bucket = options.bucket;
    this.maxRetries = options.maxRetries ?? 200;
  }

  private open(): Promise<Handle> {
    this.handle ??= (async () => {
      const { bucket, history, maxBytes, replicas, markerTtl } = this.options;
      let kv: KV;
      let status: Awaited<ReturnType<KV["status"]>>;
      try {
        kv = await openKv(bucket, { create: false });
        status = await kv.status();
      } catch {
        kv = await openKv(bucket, {
          create: true,
          markerTtl: markerTtl ?? 1000,
          ...(history !== undefined && { history }),
          ...(maxBytes !== undefined && { maxBytes }),
          ...(replicas !== undefined && { replicas }),
        });
        status = await kv.status();
      }
      const nativeTtl = status.streamInfo.config.allow_msg_ttl === true;
      return { kv, nativeTtl };
    })();
    this.handle.catch(() => {
      this.handle = undefined;
    });
    return this.handle;
  }

  get nativeTtl(): Promise<boolean> {
    return this.open().then((h) => h.nativeTtl);
  }

  async kv(): Promise<KV> {
    return (await this.open()).kv;
  }

  async read(key: string): Promise<{ rev: number; rec: KvRecord | null }> {
    const { kv } = await this.open();
    const entry = await kv.get(encodeKey(key));
    if (!entry) return { rev: 0, rec: null };
    if (entry.operation !== "PUT") return { rev: entry.revision, rec: null };
    const rec = JSON.parse(decoder.decode(entry.value)) as KvRecord;
    if (rec.x !== undefined && rec.x <= Date.now()) return { rev: entry.revision, rec: null };
    return { rev: entry.revision, rec };
  }

  async write(key: string, rec: KvRecord, rev: number | undefined): Promise<boolean> {
    const { kv, nativeTtl } = await this.open();
    const ek = encodeKey(key);
    const data = encoder.encode(JSON.stringify(rec));
    const ttl = nativeTtl && rec.x !== undefined ? `${Math.max(1, Math.ceil((rec.x - Date.now()) / 1000))}s` : undefined;
    try {
      if (ttl) {
        const js = await getJs();
        await js.publish(`$KV.${this.bucket}.${ek}`, data, {
          ttl,
          expect: rev === undefined ? {} : { lastSubjectSequence: rev },
        });
      } else if (rev === 0) await kv.create(ek, data);
      else if (rev === undefined) await kv.put(ek, data);
      else await kv.update(ek, data, rev);
      return true;
    } catch (err) {
      if (isConflict(err)) return false;
      throw err;
    }
  }

  async remove(key: string, rev: number): Promise<boolean> {
    const { kv } = await this.open();
    try {
      await kv.delete(encodeKey(key), { previousSeq: rev });
      return true;
    } catch (err) {
      if (isConflict(err)) return false;
      throw err;
    }
  }

  async mutate<R>(
    key: string,
    fn: (current: KvRecord | null) => { next: KvRecord | null | undefined; result: R },
  ): Promise<R> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const { rev, rec } = await this.read(key);
      const { next, result } = fn(rec);
      if (next === undefined) return result;
      const ok = next === null ? (rec === null ? true : await this.remove(key, rev)) : await this.write(key, next, rev);
      if (ok) return result;
      if (attempt > 2) await new Promise((r) => setTimeout(r, Math.random() * Math.min(5 * attempt, 50)));
    }
    throw new KvError("ERR", `contention on key "${key}" exceeded ${this.maxRetries} retries`, { code: Code.ABORTED, reason: "CONTENTION" });
  }

  async allKeys(): Promise<string[]> {
    const { kv } = await this.open();
    const out: string[] = [];
    for await (const k of await kv.keys()) out.push(decodeKey(k));
    return out.sort();
  }
}

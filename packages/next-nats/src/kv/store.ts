import "server-only";
import { JetStreamApiCodes, JetStreamApiError } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { headers } from "@nats-io/nats-core";
import { getJs, getJsm, getNc, openKv } from "../connection.js";
import { Code, SpecError } from "../errors.js";
import { getLogger } from "../logger.js";
import { decodeKey, encodeKey } from "./key.js";

export type RecordKind = "s" | "h" | "l" | "S" | "z";

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
  atomic: boolean;
}

export interface BatchOp {
  key: string;
  rec: KvRecord | null;
  expected: number | undefined;
}

export interface RawOp {
  key: string;
  body: Uint8Array | null;
  expected: number | undefined;
  ttl?: string | undefined;
}

export interface ReadCheck {
  key: string;
  rev: number;
}

export const MAX_BATCH = 1000;

const CHECK_KEY = "~check";

export type Store = Pick<KvStore, "bucket" | "maxRetries" | "nativeTtl" | "atomic" | "kv" | "read" | "write" | "remove" | "mutate" | "allKeys">;

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

export class UpstashError extends KvError {
  constructor(code: string, message: string, spec: { code?: Code; reason?: string } = {}) {
    super(code, message, spec);
    this.name = "UpstashError";
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
      const config = status.streamInfo.config;
      const nativeTtl = config.allow_msg_ttl === true;
      let atomic = config.allow_atomic === true;
      if (!atomic) {
        try {
          await (await getJsm()).streams.update(config.name, { ...config, allow_atomic: true });
          atomic = true;
        } catch (error) {
          atomic = false;
          getLogger().warning("KV bucket does not allow atomic batches; multi() and multi-key commands are not atomic", { bucket: config.name, error });
        }
      }
      return { kv, nativeTtl, atomic };
    })();
    this.handle.catch(() => {
      this.handle = undefined;
    });
    return this.handle;
  }

  get nativeTtl(): Promise<boolean> {
    return this.open().then((h) => h.nativeTtl);
  }

  get atomic(): Promise<boolean> {
    return this.open().then((h) => h.atomic);
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
    throw new UpstashError("ERR", `contention on key "${key}" exceeded ${this.maxRetries} retries`, { code: Code.ABORTED, reason: "CONTENTION" });
  }

  async commit(ops: BatchOp[], reads: ReadCheck[] = []): Promise<boolean> {
    if (ops.length === 0) return true;
    const total = ops.length + reads.length;
    if (total > MAX_BATCH) {
      throw new UpstashError("ERR", `transaction touches ${total} keys, the limit is ${MAX_BATCH}`);
    }
    const { kv, nativeTtl } = await this.open();
    const only = ops[0] as BatchOp;
    if (total === 1) {
      if (only.rec) return this.write(only.key, only.rec, only.expected);
      if (only.expected !== undefined) return this.remove(only.key, only.expected);
      await kv.delete(encodeKey(only.key));
      return true;
    }
    return this.batch(
      ops.map((op) => ({
        key: op.key,
        expected: op.expected,
        body: op.rec === null ? null : encoder.encode(JSON.stringify(op.rec)),
        ttl: op.rec?.x !== undefined && nativeTtl ? `${Math.max(1, Math.ceil((op.rec.x - Date.now()) / 1000))}s` : undefined,
      })),
      reads,
    );
  }

  async batch(ops: RawOp[], reads: ReadCheck[] = []): Promise<boolean> {
    const total = ops.length + reads.length;
    if (total > MAX_BATCH) {
      throw new UpstashError("ERR", `transaction touches ${total} keys, the limit is ${MAX_BATCH}`);
    }
    const { atomic } = await this.open();
    if (!atomic) throw new UpstashError("ERR", "the server does not support atomic batch publish");
    const nc = await getNc();
    const id = crypto.randomUUID();
    const last = total - 1;
    const replies: Promise<unknown>[] = [];
    for (let i = 0; i < total; i++) {
      const h = headers();
      h.set("Nats-Batch-Id", id);
      h.set("Nats-Batch-Sequence", String(i + 1));
      let subject: string;
      let data: Uint8Array;
      const op = ops[i];
      if (op) {
        if (op.expected !== undefined) h.set("Nats-Expected-Last-Subject-Sequence", String(op.expected));
        if (op.body === null) h.set("KV-Operation", "DEL");
        else if (op.ttl !== undefined) h.set("Nats-TTL", op.ttl);
        subject = `$KV.${this.bucket}.${encodeKey(op.key)}`;
        data = op.body ?? new Uint8Array();
      } else {
        const read = reads[i - ops.length] as ReadCheck;
        h.set("Nats-Expected-Last-Subject-Sequence", String(read.rev));
        h.set("Nats-Expected-Last-Subject-Sequence-Subject", `$KV.${this.bucket}.${encodeKey(read.key)}`);
        h.set("KV-Operation", "DEL");
        subject = `$KV.${this.bucket}.${CHECK_KEY}`;
        data = new Uint8Array();
      }
      if (i < last) {
        nc.publish(subject, data, { headers: h });
        continue;
      }
      h.set("Nats-Batch-Commit", "1");
      replies.push(nc.request(subject, data, { headers: h, timeout: 10_000 }));
    }
    const msg = (await replies[0]) as { json: <T>() => T };
    const ack = msg.json<{ count?: number; error?: { code: number; err_code: number; description: string } }>();
    if (ack.error) {
      if (ack.error.err_code === JetStreamApiCodes.StreamWrongLastSequence || ack.error.err_code === JetStreamApiCodes.StreamWrongLastSequenceUnknown) {
        return false;
      }
      throw new UpstashError("ERR", `atomic batch rejected: ${ack.error.description}`, { code: Code.ABORTED });
    }
    return ack.count === total;
  }

  async allKeys(): Promise<string[]> {
    const { kv } = await this.open();
    const out: string[] = [];
    for await (const k of await kv.keys()) out.push(decodeKey(k));
    return out.sort();
  }
}

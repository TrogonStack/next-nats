import { Kvm, type KV } from "@nats-io/kv";
import { Code, SpecError, Visibility } from "../errors.js";
import { decodeKey, encodeKey, globToRegExp } from "../kv/key.js";
import { decodeRecord, deserialize, encodeRecord, isExpired, nativeTtlOf, serializeValue, type KvRecord } from "../kv/record.js";
import { bucketName, type BucketName } from "../values.js";
import { getEdgeNats } from "./connection.js";

const DOMAIN = "next-nats.edge";

export interface EdgeKvEntry<T = unknown> {
  readonly bucket: BucketName;
  readonly key: string;
  readonly revision: number;
  readonly value: T;
  readonly expiresAt?: Date;
}

export interface EdgeKvPutOptions {
  expectedRevision?: number;
  ttlSeconds?: number;
}

export interface EdgeKv {
  readonly bucket: BucketName;
  get<T = unknown>(key: string): Promise<EdgeKvEntry<T> | undefined>;
  put(key: string, value: unknown, opts?: EdgeKvPutOptions): Promise<number>;
  delete(key: string): Promise<void>;
  keys(match?: string): Promise<string[]>;
}

interface Handle {
  kv: KV;
  nativeTtl: boolean;
}

const handles = new Map<string, Promise<Handle>>();

function missingBucket(bucket: BucketName, cause: unknown): SpecError {
  return new SpecError({
    code: Code.NOT_FOUND,
    domain: DOMAIN,
    reason: "BUCKET_NOT_FOUND",
    message: `KV bucket "${bucket}" does not exist: the Edge runtime never provisions buckets, create it from the Node runtime first`,
    visibility: Visibility.INTERNAL,
    cause,
  });
}

function wrongType(key: string, kind: string): SpecError {
  return new SpecError({
    code: Code.FAILED_PRECONDITION,
    domain: DOMAIN,
    reason: "WRONG_TYPE",
    message: `KV key "${key}" holds a "${kind}" record, the Edge runtime only reads string values`,
    visibility: Visibility.INTERNAL,
  });
}

function isMissingBucket(error: unknown): boolean {
  return error instanceof Error && error.name === "StreamNotFoundError";
}

async function openBucket(bucket: BucketName): Promise<Handle> {
  const cached = handles.get(bucket);
  if (cached) return cached;
  const opening = (async () => {
    const { js } = await getEdgeNats();
    try {
      const kv = await new Kvm(js).open(bucket);
      const status = await kv.status();
      return { kv, nativeTtl: status.streamInfo.config.allow_msg_ttl === true };
    } catch (error) {
      throw isMissingBucket(error) ? missingBucket(bucket, error) : error;
    }
  })();
  handles.set(bucket, opening);
  opening.catch(() => handles.delete(bucket));
  return opening;
}

export function edgeKv(bucket: BucketName | string): EdgeKv {
  const name = bucketName(bucket);
  return {
    bucket: name,
    async get<T>(key: string) {
      const { kv } = await openBucket(name);
      const entry = await kv.get(encodeKey(key));
      if (!entry || entry.operation !== "PUT") return undefined;
      const rec = decodeRecord(entry.value);
      if (isExpired(rec)) return undefined;
      if (rec.t !== "s") throw wrongType(key, rec.t);
      return {
        bucket: name,
        key,
        revision: entry.revision,
        value: deserialize<T>(rec.v as string, true) as T,
        ...(rec.x !== undefined && { expiresAt: new Date(rec.x) }),
      };
    },
    async put(key, value, opts = {}) {
      const { kv, nativeTtl } = await openBucket(name);
      const encoded = encodeKey(key);
      const rec: KvRecord = {
        t: "s",
        v: serializeValue(value),
        ...(opts.ttlSeconds !== undefined && { x: Date.now() + opts.ttlSeconds * 1000 }),
      };
      const data = encodeRecord(rec);
      const ttl = nativeTtl ? nativeTtlOf(rec) : undefined;
      if (ttl) {
        const { js } = await getEdgeNats();
        const ack = await js.publish(`$KV.${name}.${encoded}`, data, {
          ttl,
          expect: opts.expectedRevision === undefined ? {} : { lastSubjectSequence: opts.expectedRevision },
        });
        return ack.seq;
      }
      return opts.expectedRevision === undefined ? kv.put(encoded, data) : kv.update(encoded, data, opts.expectedRevision);
    },
    async delete(key) {
      await (await openBucket(name)).kv.delete(encodeKey(key));
    },
    async keys(match) {
      const pattern = match === undefined ? undefined : globToRegExp(match);
      const iterator = await (await openBucket(name)).kv.keys();
      const keys: string[] = [];
      for await (const encoded of iterator) {
        const key = decodeKey(encoded);
        if (!pattern || pattern.test(key)) keys.push(key);
      }
      return keys.sort();
    },
  };
}

export function resetEdgeKvHandles(): void {
  handles.clear();
}

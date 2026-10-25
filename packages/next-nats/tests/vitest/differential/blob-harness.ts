import * as realSdk from "@vercel/blob";
import { createHash } from "node:crypto";
import { closeNats, connectNats, getNats } from "../../../src/connection.js";
import * as oursSdk from "../../../src/blob/index.js";
import { configureBlob } from "../../../src/blob/index.js";
import { startFakeVercelBlob, type FakeVercelBlob } from "../../support/fakes/vercel-blob.js";

export type BlobApi = Pick<
  typeof realSdk,
  | "put"
  | "head"
  | "get"
  | "del"
  | "list"
  | "copy"
  | "rename"
  | "createFolder"
  | "createMultipartUpload"
  | "createMultipartUploader"
  | "uploadPart"
  | "completeMultipartUpload"
>;

export type SubjectName = "real" | "ours";

export interface Subject {
  readonly name: SubjectName;
  readonly api: BlobApi;
  readonly origin: string;
  readonly token: string;
  begin(): Promise<void>;
}

export interface Harness {
  readonly fake: FakeVercelBlob;
  readonly real: Subject;
  readonly ours: Subject;
  readonly oursBaseUrl: string;
  close(): Promise<void>;
}

const SDK_ERROR_CLASSES = new Set([
  "BlobAccessError",
  "BlobClientTokenExpiredError",
  "BlobContentTypeNotAllowedError",
  "BlobError",
  "BlobFileTooLargeError",
  "BlobNotFoundError",
  "BlobPathnameMismatchError",
  "BlobPreconditionFailedError",
  "BlobRequestAbortedError",
  "BlobServiceNotAvailable",
  "BlobServiceRateLimited",
  "BlobStoreNotFoundError",
  "BlobStoreSuspendedError",
  "BlobUnknownError",
]);

const OURS_BASE_URL = "http://ours.blob.test/blob";

export async function startHarness(): Promise<Harness> {
  const fake = await startFakeVercelBlob();
  process.env.VERCEL_BLOB_API_URL = fake.apiUrl;
  process.env.BLOB_READ_WRITE_TOKEN = fake.readWriteToken;
  process.env.VERCEL_BLOB_RETRIES = "0";
  await connectNats({ servers: process.env.NATS_SERVERS, name: "next-nats-blob-differential" });

  const run = Math.random().toString(36).slice(2, 8);
  let sequence = 0;
  const buckets: string[] = [];

  const real: Subject = {
    name: "real",
    api: realSdk as BlobApi,
    origin: fake.origin,
    token: fake.readWriteToken,
    async begin() {
      fake.reset();
    },
  };

  const ours: Subject = {
    name: "ours",
    api: oursSdk as unknown as BlobApi,
    origin: OURS_BASE_URL,
    token: fake.readWriteToken,
    async begin() {
      const bucket = `bd_${run}_${sequence++}`;
      buckets.push(bucket);
      configureBlob({ bucket, baseUrl: OURS_BASE_URL, secret: fake.readWriteToken });
    },
  };

  return {
    fake,
    real,
    ours,
    oursBaseUrl: OURS_BASE_URL,
    async close() {
      const { jsm } = await getNats();
      await Promise.all(
        buckets.flatMap((bucket) => [`OBJ_${bucket}`, `OBJ_${bucket}_mpu`].map((stream) => jsm.streams.delete(stream).catch(() => undefined))),
      );
      await closeNats();
      await fake.close();
    },
  };
}

export interface ObservedError {
  sdkClass: string;
  name: string;
  message: string;
}

export type Observed = { ok: unknown } | { error: ObservedError };

export function sdkClassOf(error: unknown): string {
  let proto: unknown = error instanceof Error ? Object.getPrototypeOf(error) : null;
  while (proto && proto !== Object.prototype) {
    const name = (proto as { constructor: { name: string } }).constructor.name;
    if (SDK_ERROR_CLASSES.has(name)) return name;
    proto = Object.getPrototypeOf(proto);
  }
  return error instanceof Error ? error.constructor.name : typeof error;
}

export async function observe(run: () => Promise<unknown>): Promise<Observed> {
  try {
    return { ok: await run() };
  } catch (error) {
    if (error instanceof Error) {
      return { error: { sdkClass: sdkClassOf(error), name: error.name, message: error.message } };
    }
    return { error: { sdkClass: typeof error, name: "", message: String(error) } };
  }
}

export interface Normalizer {
  value(input: unknown): unknown;
}

export function createNormalizer(origin: string, options: { maskSuffix?: boolean } = {}): Normalizer {
  const etags = new Map<string, string>();
  const alias = (etag: string) => {
    let known = etags.get(etag);
    if (!known) {
      known = `<etag:${etags.size + 1}>`;
      etags.set(etag, known);
    }
    return known;
  };
  const suffix = /-[A-Za-z0-9]{10,40}(?=\.[A-Za-z0-9]+(?:["?\\]|$)|["?\\]|$)/g;
  const text = (input: string) => {
    let out = input.split(origin).join("<origin>");
    if (options.maskSuffix) out = out.replace(suffix, "-<suffix>");
    return out;
  };
  const walk = (input: unknown, key?: string): unknown => {
    if (input === null || input === undefined) return input;
    if (input instanceof Date) return "<Date>";
    if (typeof input === "string") {
      if (key === "etag") return alias(input);
      if (key === "cursor") return "<cursor>";
      return text(input);
    }
    if (Array.isArray(input)) return input.map((item) => walk(item));
    if (typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]));
    }
    return input;
  };
  return { value: (input) => walk(input) };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function bytesOf(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ScenarioContext {
  api: BlobApi;
  subject: SubjectName;
  origin: string;
  token: string;
  log: unknown[];
  record(label: string, value: unknown): void;
  attempt(label: string, run: () => Promise<unknown>): Promise<void>;
}

export interface Scenario {
  name: string;
  maskSuffix?: boolean;
  run(ctx: ScenarioContext): Promise<void>;
}

export async function transcript(subject: Subject, scenario: Scenario): Promise<unknown[]> {
  await subject.begin();
  const log: unknown[] = [];
  const ctx: ScenarioContext = {
    api: subject.api,
    subject: subject.name,
    origin: subject.origin,
    token: subject.token,
    log,
    record: (label, value) => log.push({ label, value }),
    attempt: async (label, run) => {
      log.push({ label, ...(await observe(run)) });
    },
  };
  await scenario.run(ctx);
  const normalizer = createNormalizer(subject.origin, { maskSuffix: scenario.maskSuffix });
  return normalizer.value(log) as unknown[];
}

import { createHash, randomUUID } from "node:crypto";
import { headers as natsHeaders } from "@nats-io/nats-core";
import type { JsMsg } from "@nats-io/jetstream";
import { getNats } from "../connection.js";
import { ensureStream } from "../streams.js";
import { subject } from "../values.js";
import { BadRequestError, MessageCorruptedError, PayloadTooLargeError } from "./errors.js";
import type { SendOptions, SendResult } from "./types.js";

const NANOS_PER_SECOND = 1_000_000_000;
const DAY_SECONDS = 86_400;
const NAME = /^[A-Za-z0-9_-]+$/;
const REGION = /^[a-z]{2,5}[0-9]{1,2}$/;

export const DEFAULT_RETENTION_SECONDS = DAY_SECONDS;
export const MAX_RETENTION_SECONDS = 7 * DAY_SECONDS;
export const MIN_RETENTION_SECONDS = 60;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
export const DEFAULT_REGION = "iad1";

export interface QueueStoreOptions {
  stream?: string;
  prefix?: string;
}

export interface QueueStore {
  readonly stream: string;
  readonly prefix: string;
}

const CONFIG_KEY = Symbol.for("next-nats.queue.store");

export function configureQueue(options: QueueStoreOptions): void {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = options;
}

export function resolveStore(options: QueueStoreOptions = {}, env: Record<string, string | undefined> = process.env): QueueStore {
  const configured = ((globalThis as Record<symbol, unknown>)[CONFIG_KEY] ?? {}) as QueueStoreOptions;
  return {
    stream: options.stream ?? configured.stream ?? (env.NATS_QUEUE_STREAM || "QUEUE"),
    prefix: options.prefix ?? configured.prefix ?? (env.NATS_QUEUE_PREFIX || "queue"),
  };
}

export function resolveRegion(region: string | undefined, env: Record<string, string | undefined> = process.env): string {
  const resolved = region ?? (env.VERCEL_REGION || DEFAULT_REGION);
  if (!REGION.test(resolved)) {
    throw new Error(`Invalid region code: ${JSON.stringify(resolved)}. Region must match the pattern /^[a-z]{2,5}[0-9]{1,2}$/ (e.g. "iad1", "lhr1").`);
  }
  return resolved;
}

export function assertName(kind: "topic" | "consumer group", value: string): string {
  if (!NAME.test(value)) throw new BadRequestError(`Invalid ${kind} name "${value}": must match [A-Za-z0-9_-]+`);
  return value;
}

export function matchesTopic(pattern: string, topic: string): boolean {
  return pattern.endsWith("*") ? topic.startsWith(pattern.slice(0, -1)) : pattern === topic;
}

export function durableFor(pattern: string, group: string): string {
  return `${pattern.replace(/\*/g, "_W")}__${group}`;
}

export function subjects(store: QueueStore, topic: string) {
  return {
    message: subject(`${store.prefix}.t.${topic}`),
    schedule: (id: string) => subject(`${store.prefix}.s.${topic}.${id}`),
  };
}

export function filterSubject(store: QueueStore, pattern: string): string {
  return pattern.endsWith("*") ? `${store.prefix}.t.>` : `${store.prefix}.t.${pattern}`;
}

const provisioned = new Map<string, Promise<unknown>>();

export function provision(store: QueueStore): Promise<unknown> {
  const key = store.stream;
  let ready = provisioned.get(key);
  if (!ready) {
    ready = ensureStream({
      name: store.stream,
      subjects: [`${store.prefix}.t.>`, `${store.prefix}.s.>`],
      max_age: MAX_RETENTION_SECONDS * NANOS_PER_SECOND,
      duplicate_window: DAY_SECONDS * NANOS_PER_SECOND,
      allow_msg_schedules: true,
      allow_msg_ttl: true,
    } as Parameters<typeof ensureStream>[0]).catch((error) => {
      provisioned.delete(key);
      throw error;
    });
    provisioned.set(key, ready);
  }
  return ready;
}

export function forgetProvisioned(stream: string): void {
  provisioned.delete(stream);
}

export const HEADER = {
  messageId: "Vqs-Message-Id",
  createdAt: "Vqs-Created-At",
  expiresAt: "Vqs-Expires-At",
  visibleAt: "Vqs-Visible-At",
  region: "Vqs-Region",
  contentType: "Content-Type",
} as const;

function isReservedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "authorization" || lower === "content-type" || lower.startsWith("vqs-") || lower.startsWith("nats-");
}

export function userHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value !== undefined && !isReservedHeader(name)) out[name] = value;
  }
  return out;
}

function validate(opts: SendOptions): { retention: number; delay: number } {
  if (opts.experimental_concurrencyKey !== undefined) {
    throw new BadRequestError("experimental_concurrencyKey is not supported by the NATS queue");
  }
  if (opts.idempotencyKey !== undefined && opts.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new BadRequestError(`idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  const retention = opts.retentionSeconds ?? DEFAULT_RETENTION_SECONDS;
  if (!Number.isFinite(retention) || retention < MIN_RETENTION_SECONDS || retention > MAX_RETENTION_SECONDS) {
    throw new BadRequestError(`retentionSeconds must be between ${MIN_RETENTION_SECONDS} and ${MAX_RETENTION_SECONDS}`);
  }
  const delay = opts.delaySeconds ?? 0;
  if (!Number.isFinite(delay) || delay < 0 || delay > MAX_RETENTION_SECONDS) {
    throw new BadRequestError(`delaySeconds must be between 0 and ${MAX_RETENTION_SECONDS}`);
  }
  return { retention, delay };
}

export function messageIdFor(idempotencyKey: string | undefined): string {
  return idempotencyKey ? createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32) : randomUUID();
}

export async function publishMessage(
  store: QueueStore,
  region: string,
  topic: string,
  body: Uint8Array,
  contentType: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  assertName("topic", topic);
  const { retention, delay } = validate(opts);
  await provision(store);
  const { nc, js } = await getNats();
  const maxPayload = nc.info?.max_payload;
  if (maxPayload !== undefined && body.length > maxPayload) {
    throw new PayloadTooLargeError(`Payload of ${body.length} bytes exceeds the NATS max_payload of ${maxPayload} bytes`);
  }
  const id = messageIdFor(opts.idempotencyKey);
  const now = Date.now();
  const h = natsHeaders();
  for (const [name, value] of Object.entries(userHeaders(opts.headers))) h.set(name, value);
  h.set(HEADER.contentType, contentType);
  h.set(HEADER.messageId, id);
  h.set(HEADER.region, region);
  h.set(HEADER.createdAt, new Date(now).toISOString());
  h.set(HEADER.visibleAt, new Date(now + delay * 1000).toISOString());
  h.set(HEADER.expiresAt, new Date(now + retention * 1000).toISOString());
  const names = subjects(store, topic);
  const msgID = opts.idempotencyKey ? `${topic}:${opts.idempotencyKey}` : id;
  if (delay > 0) {
    await js.publish(names.schedule(randomUUID()), body, {
      msgID,
      headers: h,
      ttl: String(delay + retention),
      schedule: { specification: new Date(now + delay * 1000), target: names.message, ttl: String(retention) },
    });
  } else {
    await js.publish(names.message, body, { msgID, headers: h, ttl: String(retention) });
  }
  return { messageId: id };
}

export interface StoredMessage {
  messageId: string;
  contentType: string;
  region: string;
  createdAt: Date;
  expiresAt: Date;
  visibleAt: Date;
  deliveryCount: number;
  headers: Record<string, string>;
  body: Uint8Array;
  reply: string;
  topic: string;
}

export function replyOf(msg: JsMsg): string {
  return (msg as JsMsg & { reply: string }).reply;
}

export function readStored(msg: JsMsg, store: QueueStore): StoredMessage {
  const h = msg.headers;
  const messageId = h?.get(HEADER.messageId);
  if (!messageId) throw new MessageCorruptedError(`seq ${msg.seq}`, "missing Vqs-Message-Id header");
  const createdAt = new Date(h!.get(HEADER.createdAt) || Date.now());
  const user: Record<string, string> = {};
  for (const key of h!.keys()) {
    if (!isReservedHeader(key)) user[key] = h!.get(key);
  }
  return {
    messageId,
    contentType: h!.get(HEADER.contentType) || "application/json",
    region: h!.get(HEADER.region) || DEFAULT_REGION,
    createdAt,
    expiresAt: new Date(h!.get(HEADER.expiresAt) || createdAt.getTime() + DAY_SECONDS * 1000),
    visibleAt: new Date(h!.get(HEADER.visibleAt) || createdAt),
    deliveryCount: msg.info.deliveryCount,
    headers: user,
    body: msg.data,
    reply: replyOf(msg),
    topic: msg.subject.slice(store.prefix.length + 3),
  };
}

import "server-only";
import { JetStreamApiCodes, JetStreamApiError, type StoredMsg } from "@nats-io/jetstream";
import type { MsgHdrs } from "@nats-io/nats-core";
import { codec } from "./codec.js";
import { defineConsumer, type ActiveConsumer } from "./consumer.js";
import { getNats, getNatsConfig, onNatsShutdown } from "./connection.js";
import type { DurationInput } from "./duration.js";
import { invalidArgument } from "./errors.js";
import { ensureStream, type StreamSpec } from "./streams.js";
import { durableName, streamName, subject, type DurableName, type StreamName, type Subject } from "./values.js";

export const MAX_DELIVERIES_ADVISORY_PREFIX = "$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES";
export const MSG_TERMINATED_ADVISORY_PREFIX = "$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED";
export const MAX_DELIVERIES_ADVISORY_TYPE = "io.nats.jetstream.advisory.v1.max_deliver";
export const MSG_TERMINATED_ADVISORY_TYPE = "io.nats.jetstream.advisory.v1.terminated";

export type DeadLetterKind = "max_deliveries" | "terminated";

export interface DeadLetterEvent {
  readonly kind: DeadLetterKind;
  readonly stream: StreamName;
  readonly consumer: DurableName;
  readonly streamSeq: number;
  readonly deliveries: number;
  readonly consumerSeq?: number;
  readonly reason?: string;
  readonly domain?: string;
  readonly id?: string;
  readonly timestamp?: Date;
}

export interface DeadLetterOriginal {
  readonly subject: string;
  readonly seq: number;
  readonly data: Uint8Array;
  readonly payload: unknown;
  readonly headers: MsgHdrs;
  readonly time: Date;
}

const DOMAIN = "next-nats.dead-letter";

function malformed(detail: string) {
  return invalidArgument(DOMAIN, "MALFORMED_ADVISORY", `Malformed JetStream advisory: ${detail}`);
}

function integer(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(`"${key}" must be a non-negative integer`);
  }
  return value;
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw malformed(`"${key}" must be a non-empty string`);
  return value;
}

function named<T>(make: (value: string) => T, value: string): T {
  try {
    return make(value);
  } catch (error) {
    throw malformed(error instanceof Error ? error.message : String(error));
  }
}

function kindOf(type: unknown): DeadLetterKind {
  if (type === MAX_DELIVERIES_ADVISORY_TYPE) return "max_deliveries";
  if (type === MSG_TERMINATED_ADVISORY_TYPE) return "terminated";
  throw malformed(`unsupported type ${JSON.stringify(type)}`);
}

export function toDeadLetterEvent(advisory: unknown): DeadLetterEvent {
  if (!advisory || typeof advisory !== "object" || Array.isArray(advisory)) throw malformed("payload is not an object");
  const record = advisory as Record<string, unknown>;
  const kind = kindOf(record.type);
  const timestamp = typeof record.timestamp === "string" ? new Date(record.timestamp) : undefined;
  return {
    kind,
    stream: named(streamName, text(record, "stream")),
    consumer: named(durableName, text(record, "consumer")),
    streamSeq: integer(record, "stream_seq"),
    deliveries: integer(record, "deliveries"),
    ...(kind === "terminated" && typeof record.consumer_seq === "number" && { consumerSeq: record.consumer_seq }),
    ...(kind === "terminated" && typeof record.reason === "string" && record.reason.length > 0 && { reason: record.reason }),
    ...(typeof record.domain === "string" && record.domain.length > 0 && { domain: record.domain }),
    ...(typeof record.id === "string" && { id: record.id }),
    ...(timestamp && !Number.isNaN(timestamp.getTime()) && { timestamp }),
  };
}

export function deadLetterAdvisorySubjects(stream: StreamName | string, consumer: DurableName | string = "*"): Subject[] {
  const s = stream === "*" ? "*" : streamName(stream);
  const c = consumer === "*" ? "*" : durableName(consumer);
  return [subject(`${MAX_DELIVERIES_ADVISORY_PREFIX}.${s}.${c}`), subject(`${MSG_TERMINATED_ADVISORY_PREFIX}.${s}.${c}`)];
}

export interface DeadLetterCaptureOptions {
  name?: string;
  streams?: Array<StreamName | string>;
  maxAge?: DurationInput;
  storage?: "file" | "memory";
  replicas?: number;
}

export const DEFAULT_DEAD_LETTER_CAPTURE_STREAM = "NEXT_NATS_DEAD_LETTERS";

export function deadLetterCaptureSpec(opts: DeadLetterCaptureOptions = {}): StreamSpec {
  const monitored = opts.streams?.length ? opts.streams : ["*"];
  return {
    name: opts.name ?? DEFAULT_DEAD_LETTER_CAPTURE_STREAM,
    subjects: monitored.flatMap((stream) => deadLetterAdvisorySubjects(stream)),
    maxAge: opts.maxAge ?? "7d",
    ...(opts.storage && { storage: opts.storage as StreamSpec["storage"] }),
    ...(opts.replicas !== undefined && { replicas: opts.replicas }),
  };
}

export function ensureDeadLetterCaptureStream(opts: DeadLetterCaptureOptions = {}) {
  return ensureStream(deadLetterCaptureSpec(opts));
}

export interface DeadLetterConsumerDefinition {
  stream: StreamName | string;
  durable: DurableName | string;
  filter?: DurableName | string;
  capture?: { stream: StreamName | string } | StreamName | string;
  handler: (event: DeadLetterEvent, original: DeadLetterOriginal | undefined) => void | Promise<void>;
  onError?: (error: unknown, event?: DeadLetterEvent) => void;
}

export interface ActiveDeadLetterConsumer {
  readonly durable: DurableName;
  readonly mode: "jetstream" | "core";
  stop(): Promise<void>;
}

const REGISTRY_KEY = Symbol.for("next-nats.dead-letter-consumers");

function registry(): Map<string, ActiveDeadLetterConsumer> {
  const g = globalThis as unknown as Record<symbol, Map<string, ActiveDeadLetterConsumer> | undefined>;
  return (g[REGISTRY_KEY] ??= new Map());
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof JetStreamApiError &&
    (error.code === JetStreamApiCodes.NoMessageFound || error.code === JetStreamApiCodes.StreamNotFound)
  );
}

export async function fetchDeadLetterOriginal(event: DeadLetterEvent): Promise<DeadLetterOriginal | undefined> {
  const { jsm } = await getNats();
  let stored: StoredMsg | null;
  try {
    stored = await jsm.streams.getMessage(event.stream, { seq: event.streamSeq });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!stored) return undefined;
  return {
    subject: stored.subject,
    seq: stored.seq,
    data: stored.data,
    payload: codec.tryDecodeJson(stored.data),
    headers: stored.header,
    time: stored.time,
  };
}

export function defineDeadLetterConsumer(def: DeadLetterConsumerDefinition): ActiveDeadLetterConsumer {
  const stream = streamName(def.stream);
  const durable = durableName(def.durable);
  const filters = deadLetterAdvisorySubjects(stream, def.filter ?? "*");
  const capture =
    def.capture === undefined ? undefined : streamName(typeof def.capture === "object" ? def.capture.stream : def.capture);
  const mode = capture ? "jetstream" : "core";
  const key = `${mode}/${capture ?? "-"}/${stream}/${durable}`;

  const existing = registry().get(key);
  if (existing) return existing;

  if (!getNatsConfig().workers) {
    return { durable, mode, stop: async () => {} };
  }

  const dispatch = async (advisory: unknown) => {
    let event: DeadLetterEvent;
    try {
      event = toDeadLetterEvent(advisory);
    } catch (error) {
      def.onError?.(error);
      return;
    }
    const original = await fetchDeadLetterOriginal(event);
    await def.handler(event, original);
  };

  let active: ActiveDeadLetterConsumer;

  if (capture) {
    const inner: ActiveConsumer = defineConsumer({
      stream: capture,
      durable,
      filterSubjects: filters,
      handler: (advisory) => dispatch(advisory),
      onError: (error) => def.onError?.(error),
    });
    active = {
      durable,
      mode,
      async stop() {
        registry().delete(key);
        await inner.stop();
      },
    };
  } else {
    let stopped = false;
    let chain: Promise<void> = Promise.resolve();
    const subscriptions: Array<{ unsubscribe(): void }> = [];
    getNats().then(
      ({ nc }) => {
        if (stopped) return;
        for (const filter of filters) {
          subscriptions.push(
            nc.subscribe(filter, {
              queue: durable,
              callback: (error, msg) => {
                if (error) {
                  def.onError?.(error);
                  return;
                }
                chain = chain.then(async () => {
                  try {
                    await dispatch(codec.tryDecodeJson(msg.data));
                  } catch (e) {
                    def.onError?.(e);
                  }
                });
              },
            }),
          );
        }
      },
      (error) => def.onError?.(error),
    );
    active = {
      durable,
      mode,
      async stop() {
        stopped = true;
        registry().delete(key);
        for (const sub of subscriptions) sub.unsubscribe();
        await chain;
      },
    };
    onNatsShutdown(() => active.stop(), { stage: "consumers" });
  }

  registry().set(key, active);
  return active;
}

export async function stopAllDeadLetterConsumers(): Promise<void> {
  await Promise.all([...registry().values()].map((c) => c.stop()));
}

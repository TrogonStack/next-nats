import { createHmac, timingSafeEqual } from "node:crypto";
import type { NatsConnection } from "@nats-io/nats-core";
import { BadRequestError, UnauthorizedError } from "./errors.js";
import type { QueueStore } from "./store.js";
import type { Message, MessageHandler, MessageMetadata, RetryHandler } from "./types.js";
import type { Transport } from "./transport.js";

export const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;
export const MIN_VISIBILITY_TIMEOUT_SECONDS = 30;
export const MAX_VISIBILITY_TIMEOUT_SECONDS = 3_600;
export const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RENEWAL_INTERVAL_SECONDS = 60;
const MIN_RENEWAL_INTERVAL_SECONDS = 10;
const RETRY_INTERVAL_MS = 3_000;
const DIRECTIVE_CALL_ATTEMPTS = 3;
const DIRECTIVE_CALL_RETRY_DELAY_MS = 250;
const DEFAULT_RETENTION_MS = 86_400_000;
const NANOS_PER_MILLI = 1_000_000;

export function clampVisibility(seconds: number | undefined): number {
  return Math.min(MAX_VISIBILITY_TIMEOUT_SECONDS, Math.max(MIN_VISIBILITY_TIMEOUT_SECONDS, seconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS));
}

export function calculateRenewalInterval(visibilityTimeoutSeconds: number): number {
  return Math.min(MAX_RENEWAL_INTERVAL_SECONDS, Math.max(MIN_RENEWAL_INTERVAL_SECONDS, visibilityTimeoutSeconds / 5));
}

export interface Lease {
  extend(): Promise<void>;
  ack(): Promise<void>;
  retryIn(seconds: number): Promise<void>;
}

const encoder = new TextEncoder();

export function ackLease(nc: NatsConnection, reply: string): Lease {
  const send = async (payload: string) => {
    nc.publish(reply, encoder.encode(payload));
    await nc.flush();
  };
  return {
    extend: () => send("+WPI"),
    ack: () => send("+ACK"),
    retryIn: (seconds) => send(seconds > 0 ? `-NAK ${JSON.stringify({ delay: Math.round(seconds * 1000) * NANOS_PER_MILLI })}` : "-NAK"),
  };
}

const RECEIPT_VERSION = "r1";
const ACK_SUBJECT = /^\$JS\.ACK\.[^\s*>]+$/;

function receiptSecret(): string | undefined {
  return process.env.NATS_QUEUE_SECRET || undefined;
}

function sign(secret: string, reply: string): string {
  return createHmac("sha256", secret).update(reply).digest("base64url");
}

export function encodeReceipt(reply: string): string {
  const body = `${RECEIPT_VERSION}.${Buffer.from(reply, "utf8").toString("base64url")}`;
  const secret = receiptSecret();
  return secret ? `${body}.${sign(secret, reply)}` : body;
}

export function decodeReceipt(handle: string, store: QueueStore): string {
  const [version, encoded, signature] = handle.split(".");
  if (version !== RECEIPT_VERSION || !encoded) throw new BadRequestError("Binary mode callback: unrecognised receipt handle");
  const reply = Buffer.from(encoded, "base64url").toString("utf8");
  const tokens = reply.split(".");
  const streamIndex = tokens.length === 9 ? 2 : tokens.length >= 12 ? 4 : -1;
  if (!ACK_SUBJECT.test(reply) || tokens[streamIndex] !== store.stream) {
    throw new BadRequestError("Binary mode callback: receipt handle does not belong to this queue");
  }
  const secret = receiptSecret();
  if (secret) {
    const expected = Buffer.from(sign(secret, reply));
    const given = Buffer.from(signature ?? "");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new UnauthorizedError("Invalid receipt handle signature");
    }
  }
  return reply;
}

export interface Delivery<T> {
  topicName: string;
  consumerGroup: string;
  region: string;
  message: Message<T>;
  lease: Lease;
  visibilityTimeoutSeconds: number;
  visibilityDeadline?: Date;
  retry?: RetryHandler;
  transport?: Pick<Transport, "finalize">;
}

function startVisibilityExtension(lease: Lease, visibilityTimeoutSeconds: number, visibilityDeadline?: Date): () => void {
  const renewalMs = calculateRenewalInterval(visibilityTimeoutSeconds) * 1000;
  let firstDelayMs = renewalMs;
  if (visibilityDeadline) {
    const remaining = visibilityDeadline.getTime() - Date.now();
    firstDelayMs = remaining > 0 ? calculateRenewalInterval(remaining / 1000) * 1000 : 0;
  }
  let running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const extend = async () => {
    if (!running) return;
    try {
      await lease.extend();
      if (running) timer = setTimeout(extend, renewalMs);
    } catch {
      if (running) timer = setTimeout(extend, RETRY_INTERVAL_MS);
    }
  };
  timer = setTimeout(extend, firstDelayMs);
  return () => {
    running = false;
    if (timer) clearTimeout(timer);
  };
}

async function withAttempts(call: () => Promise<void>): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= DIRECTIVE_CALL_ATTEMPTS; attempt++) {
    try {
      return await call();
    } catch (error) {
      last = error;
      if (attempt < DIRECTIVE_CALL_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, DIRECTIVE_CALL_RETRY_DELAY_MS));
    }
  }
  throw last;
}

async function finalizePayload<T>(delivery: Delivery<T>): Promise<void> {
  const { payload } = delivery.message;
  if (delivery.transport?.finalize && payload !== undefined && payload !== null) {
    try {
      await delivery.transport.finalize(payload);
    } catch {
      return;
    }
  }
}

export function metadataOf<T>(delivery: Delivery<T>): MessageMetadata {
  const { message } = delivery;
  return {
    messageId: message.messageId,
    deliveryCount: message.deliveryCount,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt ?? new Date(message.createdAt.getTime() + DEFAULT_RETENTION_MS),
    topicName: delivery.topicName,
    consumerGroup: delivery.consumerGroup,
    region: delivery.region,
    ...(message.experimental_handoffCount !== undefined && { experimental_handoffCount: message.experimental_handoffCount }),
  };
}

export async function processDelivery<T>(handler: MessageHandler<T>, delivery: Delivery<T>): Promise<void> {
  const stop = startVisibilityExtension(delivery.lease, delivery.visibilityTimeoutSeconds, delivery.visibilityDeadline);
  const metadata = metadataOf(delivery);
  try {
    await handler(delivery.message.payload, metadata);
    stop();
    await delivery.lease.ack();
  } catch (error) {
    stop();
    if (delivery.retry) {
      let directive: ReturnType<RetryHandler>;
      try {
        directive = delivery.retry(error, metadata);
      } catch (retryError) {
        console.warn("retry handler threw:", retryError);
      }
      if (directive) {
        if ("acknowledge" in directive && directive.acknowledge) {
          try {
            await withAttempts(() => delivery.lease.ack());
          } catch (ackError) {
            console.warn("Failed to acknowledge message:", ackError);
          }
          await finalizePayload(delivery);
          return;
        }
        if ("afterSeconds" in directive && typeof directive.afterSeconds === "number") {
          try {
            await withAttempts(() => delivery.lease.retryIn(directive.afterSeconds));
          } catch (changeError) {
            console.warn("Failed to reschedule message for retry:", changeError);
          }
          await finalizePayload(delivery);
          return;
        }
      }
    }
    await finalizePayload(delivery);
    throw error;
  }
}

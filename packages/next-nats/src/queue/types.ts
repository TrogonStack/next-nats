import type { Transport } from "./transport.js";

export type AttributeValue =
  | string
  | number
  | boolean
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>;

export interface OtelSpan {
  setAttribute(key: string, value: AttributeValue): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, options?: { kind?: number; attributes?: Record<string, AttributeValue>; links?: unknown[] }, context?: unknown): OtelSpan;
}

export type VercelRegion =
  | "arn1" | "bom1" | "cdg1" | "cle1" | "cpt1" | "dub1" | "dxb1" | "fra1" | "gru1" | "hkg1"
  | "hnd1" | "iad1" | "icn1" | "kix1" | "lhr1" | "pdx1" | "sfo1" | "sin1" | "syd1" | "yul1"
  | (string & {});

export type BaseUrlResolver = (region: string) => URL;

export interface TelemetryOptions {
  isEnabled?: boolean;
  tracer?: Tracer;
  metadata?: Record<string, AttributeValue>;
}

export interface SendTelemetryOptions {
  isEnabled?: boolean;
  metadata?: Record<string, AttributeValue>;
}

export interface QueueClientOptions {
  region?: VercelRegion;
  resolveBaseUrl?: BaseUrlResolver;
  token?: string;
  headers?: Record<string, string>;
  deploymentId?: string | null;
  transport?: Transport;
  dispatcher?: unknown;
  telemetry?: TelemetryOptions;
}

export interface PollingQueueClientOptions extends QueueClientOptions {
  region: VercelRegion;
}

export interface SendOptions {
  idempotencyKey?: string;
  retentionSeconds?: number;
  delaySeconds?: number;
  headers?: Record<string, string>;
  experimental_concurrencyKey?: string;
  telemetry?: SendTelemetryOptions;
}

export interface SendMessageOptions<T = unknown> extends SendOptions {
  queueName: string;
  payload: T;
}

export interface SendResult {
  messageId: string | null;
}

export type BatchSendMessage<T = unknown> = Omit<SendMessageOptions<T>, "queueName" | "telemetry">;

export type BatchSendOptions = Pick<SendOptions, "telemetry">;

export type BatchSendResult =
  | { status: "sent"; messageId: string }
  | { status: "deferred"; messageId: null }
  | { status: "failed"; statusCode: number; error: string; retryable: boolean };

export interface Message<T = unknown> {
  messageId: string;
  payload: T;
  deliveryCount: number;
  createdAt: Date;
  expiresAt?: Date;
  contentType: string;
  receiptHandle: string;
  experimental_handoffCount?: number;
}

export type CursorFallback = "earliest" | "latest";

export interface MessageMetadata {
  messageId: string;
  deliveryCount: number;
  createdAt: Date;
  expiresAt: Date;
  topicName: string;
  consumerGroup: string;
  region: string;
  experimental_handoffCount?: number;
  experimental_coalesced?: { rerun: number; coalescedCount: number };
}

export type RetryDirective = { afterSeconds: number; experimental_handoff?: boolean } | { acknowledge: true };

export interface ExperimentalCoalescedReruns {
  experimental_maxCoalescedReruns?: number;
}

export type RetryHandler = (error: unknown, metadata: MessageMetadata) => RetryDirective | void | undefined;

export type MessageHandler<T = unknown> = (message: T, metadata: MessageMetadata) => Promise<void> | void;

export type ReceiveResult =
  | { ok: true }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "not_found"; messageId: string }
  | { ok: false; reason: "not_available"; messageId: string }
  | { ok: false; reason: "already_processed"; messageId: string };

export interface ReceiveByIdOptions extends ExperimentalCoalescedReruns {
  messageId: string;
  visibilityTimeoutSeconds?: number;
  retry?: RetryHandler;
}

export interface ReceiveBatchOptions extends ExperimentalCoalescedReruns {
  limit?: number;
  visibilityTimeoutSeconds?: number;
  cursorFallback?: CursorFallback;
  retry?: RetryHandler;
}

export type ReceiveOptions = ReceiveByIdOptions | ReceiveBatchOptions;

export type CallbackRequestInput = Request | { request: Request };

export type HandleCallbackOptions = {
  visibilityTimeoutSeconds?: number;
  retry?: RetryHandler;
} & ExperimentalCoalescedReruns;

export type NodeCallbackRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

export type NodeCallbackResponse = {
  status(code: number): { json(data: unknown): void; end(): void };
  end(): void;
};

export type ParsedCallbackV1 = {
  queueName: string;
  consumerGroup: string;
  messageId: string;
  region?: string;
};

export type ParsedCallbackV2 = {
  queueName: string;
  consumerGroup: string;
  messageId: string;
  region?: string;
  receiptHandle: string;
  deliveryCount?: number;
  createdAt?: string;
  expiresAt?: string;
  contentType?: string;
  visibilityDeadline?: string;
  experimental_handoffCount?: number;
  rawBody?: ReadableStream<Uint8Array>;
  parsedPayload?: unknown;
};

export type ParsedCallbackRequest = ParsedCallbackV1 | ParsedCallbackV2;

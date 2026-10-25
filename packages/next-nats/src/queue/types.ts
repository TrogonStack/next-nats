export interface SendOptions {
  idempotencyKey?: string;
  retentionSeconds?: number;
  delaySeconds?: number;
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId: string | null;
}

export type BatchSendMessage<T = unknown> = SendOptions & { payload: T };

export type BatchSendResult =
  | { status: "sent"; messageId: string }
  | { status: "failed"; statusCode: number; error: string; retryable: boolean };

export interface MessageMetadata {
  messageId: string;
  deliveryCount: number;
  createdAt: Date;
  expiresAt: Date;
  topicName: string;
  consumerGroup: string;
  region: string;
  headers: Record<string, string>;
}

export type RetryDirective = { afterSeconds: number } | { acknowledge: true };

export type RetryHandler = (error: unknown, metadata: MessageMetadata) => RetryDirective | void | undefined;

export type MessageHandler<T = unknown> = (message: T, metadata: MessageMetadata) => Promise<void> | void;

export interface ConsumeOptions {
  visibilityTimeoutSeconds?: number;
  retry?: RetryHandler;
  concurrency?: number;
  maxDeliveries?: number;
  cursorFallback?: "earliest" | "latest";
  onError?: (error: unknown, metadata?: MessageMetadata) => void;
}

export interface ReceiveOptions extends Omit<ConsumeOptions, "concurrency"> {
  limit?: number;
  waitSeconds?: number;
}

export type ReceiveResult = { ok: true; processed: number } | { ok: false; reason: "empty" };

export interface QueueClientOptions {
  stream?: string;
  prefix?: string;
  retentionSeconds?: number;
  maxRetentionSeconds?: number;
  duplicateWindowSeconds?: number;
  region?: string;
}

export interface QueueSubscription {
  readonly topic: string;
  readonly consumerGroup: string;
  stop(): Promise<void>;
}

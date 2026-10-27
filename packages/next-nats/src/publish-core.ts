import {
  ClosedConnectionError,
  ConnectionError,
  NoRespondersError,
  RequestError,
  TimeoutError,
  headers as natsHeaders,
  type MsgHdrs,
} from "@nats-io/nats-core";
import { invalidArgument } from "./errors.js";
import { TraceContext } from "./trace.js";
import type { Subject } from "./values.js";

export interface NatsEvents {}

export type SubjectName = (keyof NatsEvents & string) | Subject | (string & {});

export type PayloadOf<S extends string> = S extends keyof NatsEvents ? NatsEvents[S] : unknown;

export interface BackoffOptions {
  initial?: number;
  max?: number;
  multiplier?: number;
  jitter?: number;
}

export interface RetryOptions {
  attempts: number;
  backoff?: BackoffOptions;
  retryable?: (error: unknown) => boolean;
}

export interface TraceOptions {
  trace?: TraceContext;
  traceparent?: string;
  tracestate?: string;
}

export interface PublishOptions extends TraceOptions {
  msgId?: string;
  headers?: Record<string, string>;
  timeout?: number;
  retry?: RetryOptions;
}

export function resolveTrace(opts: TraceOptions): TraceContext | undefined {
  if (opts.trace) return opts.trace;
  if (opts.traceparent) return TraceContext.parse(opts.traceparent, opts.tracestate);
  return undefined;
}

export function buildHeaders(opts: { headers?: Record<string, string> } & TraceOptions): MsgHdrs | undefined {
  const trace = resolveTrace(opts);
  if (!opts.headers && !trace) return undefined;
  const h = natsHeaders();
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v);
  if (trace) {
    h.set("traceparent", trace.traceparent);
    if (trace.tracestate) h.set("tracestate", trace.tracestate);
  }
  return h;
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 8 && !chain.includes(current)) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

export function isRetriablePublishError(error: unknown): boolean {
  return causeChain(error).some(
    (e) =>
      e instanceof TimeoutError ||
      e instanceof NoRespondersError ||
      e instanceof ConnectionError ||
      e instanceof ClosedConnectionError ||
      (e instanceof RequestError && e.isNoResponders()),
  );
}

const DEFAULT_BACKOFF = { initial: 100, max: 2_000, multiplier: 2, jitter: 0.5 } as const;

export function retryDelay(attempt: number, backoff: BackoffOptions = {}, random: () => number = Math.random): number {
  const initial = backoff.initial ?? DEFAULT_BACKOFF.initial;
  const max = backoff.max ?? DEFAULT_BACKOFF.max;
  const multiplier = backoff.multiplier ?? DEFAULT_BACKOFF.multiplier;
  const jitter = Math.min(1, Math.max(0, backoff.jitter ?? DEFAULT_BACKOFF.jitter));
  const base = Math.min(max, initial * multiplier ** Math.max(0, attempt - 1));
  return Math.round(base * (1 - jitter * random()));
}

export function validateRetry(retry: RetryOptions): void {
  if (!Number.isInteger(retry.attempts) || retry.attempts < 1) {
    throw invalidArgument("next-nats.publish", "INVALID_RETRY", "retry.attempts must be an integer of at least 1");
  }
}

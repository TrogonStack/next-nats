import { toSpecError } from "../errors.js";
import { getLogger } from "../logger.js";
import { codec } from "../codec.js";

export interface SseEvent {
  id?: string | number;
  event?: string;
  data?: unknown;
  retry?: number;
  comment?: string;
}

export interface SseOptions {
  heartbeat?: number;
  retry?: number;
  maxBuffered?: number;
  headers?: HeadersInit;
}

export interface SseSink {
  readonly closed: boolean;
  send(event: SseEvent): Promise<void>;
  fail(error: unknown): void;
  close(): void;
}

export type SseCleanup = void | (() => void | Promise<void>);

const encoder = new TextEncoder();
const HIGH_WATER_MARK = 64;

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function serializeData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return codec.decodeText(data);
  return JSON.stringify(data) ?? "null";
}

export function formatSseEvent(event: SseEvent): string {
  let out = "";
  if (event.comment !== undefined) {
    for (const line of event.comment.split(/\r?\n/)) out += `: ${line}\n`;
  }
  if (event.event) out += `event: ${singleLine(event.event)}\n`;
  if (event.id !== undefined) out += `id: ${singleLine(String(event.id))}\n`;
  if (event.retry !== undefined) out += `retry: ${Math.max(0, Math.floor(event.retry))}\n`;
  if (event.data !== undefined) {
    for (const line of serializeData(event.data).split(/\r?\n/)) out += `data: ${line}\n`;
  }
  return `${out}\n`;
}

export function lastEventId(request: Request): string | undefined {
  const header = request.headers.get("last-event-id");
  if (header) return header;
  const query = new URL(request.url).searchParams.get("lastEventId");
  return query || undefined;
}

export function lastEventSequence(request: Request): number | undefined {
  const id = lastEventId(request);
  if (id === undefined || !/^\d+$/.test(id)) return undefined;
  const seq = Number(id);
  return Number.isSafeInteger(seq) ? seq : undefined;
}

export function createSseResponse(
  request: Request,
  opts: SseOptions,
  setup: (sink: SseSink) => SseCleanup,
): Response {
  const heartbeat = opts.heartbeat ?? 15_000;
  const maxBuffered = opts.maxBuffered ?? 1_000;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cleanup: SseCleanup;
  let closed = false;
  let waiters: Array<() => void> = [];

  const release = () => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w();
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    request.signal.removeEventListener("abort", finish);
    release();
    try {
      controller.close();
    } catch {
      /* already closed or cancelled */
    }
    if (cleanup) void Promise.resolve(cleanup()).catch(() => undefined);
  };

  const write = (text: string) => {
    if (closed) return;
    const queued = HIGH_WATER_MARK - (controller.desiredSize ?? 0);
    if (queued > maxBuffered) {
      finish();
      return;
    }
    controller.enqueue(encoder.encode(text));
  };

  const sink: SseSink = {
    get closed() {
      return closed;
    },
    send(event) {
      write(formatSseEvent(event));
      if (closed || (controller.desiredSize ?? 1) > 0) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    fail(error) {
      const failure = toSpecError(error);
      getLogger().error("realtime stream failed", { errorId: failure.spec.id, error });
      write(formatSseEvent({ event: "nats-error", data: { code: "UNAVAILABLE", message: "The stream is unavailable", id: failure.spec.id } }));
      finish();
    },
    close: finish,
  };

  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        if (request.signal.aborted) {
          finish();
          return;
        }
        request.signal.addEventListener("abort", finish, { once: true });
        write(formatSseEvent({ retry: opts.retry ?? 3_000, comment: "connected" }));
        if (heartbeat > 0) {
          timer = setInterval(() => write(": heartbeat\n\n"), heartbeat);
          timer.unref?.();
        }
        cleanup = setup(sink);
        if (closed && cleanup) void Promise.resolve(cleanup()).catch(() => undefined);
      },
      pull: release,
      cancel: finish,
    },
    new CountQueuingStrategy({ highWaterMark: HIGH_WATER_MARK }),
  );

  const headers = new Headers(opts.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");
  return new Response(body, { headers });
}

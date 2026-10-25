import { Readable } from "node:stream";
import type { PutBody } from "./types.js";
import { BlobFileTooLargeError } from "./errors.js";
import { invalidArgument } from "../errors.js";

export type { PutBody };

function isFileLike(body: unknown): body is { stream(): unknown } {
  return typeof body === "object" && body !== null && typeof (body as { stream?: unknown }).stream === "function";
}

export function toStream(body: PutBody): ReadableStream<Uint8Array> {
  if (typeof body === "string") return once(new TextEncoder().encode(body));
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  if (body instanceof Readable) return Readable.toWeb(body) as ReadableStream<Uint8Array>;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.stream() as ReadableStream<Uint8Array>;
  if (body instanceof ArrayBuffer) return once(new Uint8Array(body));
  if (isFileLike(body)) return body.stream() as ReadableStream<Uint8Array>;
  if (ArrayBuffer.isView(body)) return once(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  throw invalidArgument("next-nats.blob", "UNSUPPORTED_BODY", "Unsupported blob body type");
}

function once(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (bytes.length) c.enqueue(bytes);
      c.close();
    },
  });
}

export function limitSize(source: ReadableStream<Uint8Array>, max: number | undefined): ReadableStream<Uint8Array> {
  if (max === undefined) return source;
  let seen = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.length;
        if (seen > max) throw new BlobFileTooLargeError(`Body exceeds maximumSizeInBytes (${max})`);
        controller.enqueue(chunk);
      },
    }),
  );
}

export function sliceStream(source: ReadableStream<Uint8Array>, start: number, endInclusive: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let position = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        const chunkStart = position;
        position += value.length;
        if (position <= start) continue;
        const from = Math.max(0, start - chunkStart);
        const to = Math.min(value.length, endInclusive + 1 - chunkStart);
        controller.enqueue(value.subarray(from, to));
        if (position > endInclusive) {
          controller.close();
          await reader.cancel().catch(() => undefined);
        }
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  xml: "application/xml",
  pdf: "application/pdf",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  woff2: "font/woff2",
};

export function inferContentType(pathname: string): string {
  const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

export function chunked(source: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = source.getReader();
  return (async function* () {
    let pending: Uint8Array[] = [];
    let held = 0;
    const take = (): Uint8Array => {
      const merged = new Uint8Array(held);
      let offset = 0;
      for (const piece of pending) {
        merged.set(piece, offset);
        offset += piece.length;
      }
      pending = [];
      held = 0;
      return merged;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let rest = value;
        while (held + rest.length >= size) {
          const head = rest.subarray(0, size - held);
          pending.push(head);
          held += head.length;
          rest = rest.subarray(head.length);
          yield take();
        }
        if (rest.length) {
          pending.push(rest);
          held += rest.length;
        }
      }
      if (held > 0) yield take();
    } finally {
      reader.releaseLock();
    }
  })();
}

export function concat(parts: Array<() => Promise<ReadableStream<Uint8Array>>>): ReadableStream<Uint8Array> {
  let index = 0;
  let current: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!current) {
          const next = parts[index++];
          if (!next) return controller.close();
          current = (await next()).getReader();
        }
        const { done, value } = await current.read();
        if (done) {
          current = undefined;
          continue;
        }
        return controller.enqueue(value);
      }
    },
    async cancel(reason) {
      await current?.cancel(reason);
    },
  });
}

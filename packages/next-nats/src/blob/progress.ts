import type { OnUploadProgressCallback, PutBody } from "./types.js";

const encoder = new TextEncoder();

export function bodyLength(body: PutBody): number {
  if (typeof body === "string") return encoder.encode(body).byteLength;
  if (typeof (body as { byteLength?: unknown }).byteLength === "number") return (body as { byteLength: number }).byteLength;
  if (typeof (body as { size?: unknown }).size === "number") return (body as { size: number }).size;
  return 0;
}

export interface UploadProgress {
  start(): void;
  advance(loaded: number): void;
  finish(): void;
}

export function uploadProgress(report: OnUploadProgressCallback | undefined, length: number): UploadProgress {
  let loaded = 0;
  return {
    start() {
      report?.({ loaded: 0, total: length, percentage: 0 });
    },
    advance(next) {
      loaded = next;
      const total = length !== 0 ? length : next;
      const percentage = length > 0 ? Number(((next / total) * 100).toFixed(2)) : 0;
      if (percentage === 100 && length > 0) return;
      report?.({ loaded: next, total, percentage });
    },
    finish() {
      report?.({ loaded, total: loaded, percentage: 100 });
    },
  };
}

export function multipartProgress(report: OnUploadProgressCallback | undefined, length: number): UploadProgress {
  let loaded = 0;
  const emit = (next: number) => {
    const total = length || next;
    const percentage = length > 0 ? Number((((next / length) || next) * 100).toFixed(2)) : 0;
    report?.({ loaded: next, total, percentage });
  };
  return {
    start: () => emit(0),
    advance(next) {
      loaded = next;
      emit(next);
    },
    finish() {},
  };
}

export type RecordKind = "s" | "h" | "l" | "S" | "z";

export interface KvRecord {
  t: RecordKind;
  v: unknown;
  x?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeRecord(rec: KvRecord): Uint8Array {
  return encoder.encode(JSON.stringify(rec));
}

export function decodeRecord(bytes: Uint8Array): KvRecord {
  return JSON.parse(decoder.decode(bytes)) as KvRecord;
}

export function isExpired(rec: KvRecord, now: number = Date.now()): boolean {
  return rec.x !== undefined && rec.x <= now;
}

export function nativeTtlOf(rec: KvRecord, now: number = Date.now()): string | undefined {
  return rec.x === undefined ? undefined : `${Math.max(1, Math.ceil((rec.x - now) / 1000))}s`;
}

export function serializeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function deserialize<T = unknown>(raw: string | null | undefined, enabled: boolean): T | null {
  if (raw === null || raw === undefined) return null;
  if (!enabled) return raw as T;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "number" && parsed.toString() !== raw) return raw as T;
    return parsed as T;
  } catch {
    return raw as T;
  }
}

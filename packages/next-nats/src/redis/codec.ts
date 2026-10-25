import { UpstashError } from "../kv/store.js";
import type { KvRecord, RecordKind } from "../kv/store.js";

export type ZEntry = [member: string, score: number];

export function serialize(value: unknown): string {
  if (value === undefined) throw new UpstashError("ERR", "undefined is not a storable value, use null");
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

export function deserializeHashValue(raw: string, enabled: boolean): unknown {
  if (!enabled) return raw;
  const n = Number(raw);
  if (!Number.isNaN(n) && !Number.isSafeInteger(n)) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function deserializePlain(raw: string | null | undefined, enabled: boolean): unknown {
  if (raw === null || raw === undefined || !enabled) return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function wrongType(): UpstashError {
  return new UpstashError("WRONGTYPE", "Operation against a key holding the wrong kind of value");
}

export function syntaxError(): UpstashError {
  return new UpstashError("ERR", "syntax error");
}

const INTEGER = /^(0|-?[1-9]\d*)$/;
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function asInteger(value: string | undefined, message = "value is not an integer or out of range"): number {
  if (value !== undefined && INTEGER.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new UpstashError("ERR", message);
}

export function asFloat(value: string | undefined, message = "value is not a valid float"): number {
  const n = value !== undefined && FLOAT.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) throw new UpstashError("ERR", message);
  return n;
}

export function checkKind<T>(rec: KvRecord | null, kind: RecordKind): T | null {
  if (!rec) return null;
  if (rec.t !== kind) throw wrongType();
  return rec.v as T;
}

export function isEmptyValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export function range(start: number, end: number, length: number): [number, number] | null {
  let from = start < 0 ? length + start : start;
  let to = end < 0 ? length + end : end;
  if (from < 0) from = 0;
  if (to >= length) to = length - 1;
  if (length === 0 || from > to || from >= length) return null;
  return [from, to];
}

export function sliceRange<T>(items: readonly T[], start: number, end: number): T[] {
  const r = range(start, end, items.length);
  return r ? items.slice(r[0], r[1] + 1) : [];
}

export function compareMembers(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortZ(entries: ZEntry[]): ZEntry[] {
  return entries.sort((a, b) => a[1] - b[1] || compareMembers(a[0], b[0]));
}

export type ScoreBound = { value: number; exclusive: boolean };

export function parseScoreBound(raw: number | string): ScoreBound {
  if (typeof raw === "number") return { value: raw, exclusive: false };
  const exclusive = raw.startsWith("(");
  const text = exclusive ? raw.slice(1) : raw;
  const lower = text.toLowerCase();
  const value = lower === "-inf" ? Number.NEGATIVE_INFINITY : lower === "+inf" || lower === "inf" ? Number.POSITIVE_INFINITY : Number(text);
  if (Number.isNaN(value)) throw new UpstashError("ERR", "min or max is not a float");
  return { value, exclusive };
}

export function inScoreRange(score: number, min: ScoreBound, max: ScoreBound): boolean {
  const aboveMin = min.exclusive ? score > min.value : score >= min.value;
  const belowMax = max.exclusive ? score < max.value : score <= max.value;
  return aboveMin && belowMax;
}

export type LexBound = { kind: "min" } | { kind: "max" } | { kind: "value"; value: string; exclusive: boolean };

export function parseLexBound(raw: string): LexBound {
  if (raw === "-") return { kind: "min" };
  if (raw === "+") return { kind: "max" };
  if (raw.startsWith("(")) return { kind: "value", value: raw.slice(1), exclusive: true };
  if (raw.startsWith("[")) return { kind: "value", value: raw.slice(1), exclusive: false };
  throw new UpstashError("ERR", "min or max not valid string range item");
}

export function inLexRange(member: string, min: LexBound, max: LexBound): boolean {
  const aboveMin =
    min.kind === "min" ? true : min.kind === "max" ? false : min.exclusive ? member > min.value : member >= min.value;
  const belowMax =
    max.kind === "max" ? true : max.kind === "min" ? false : max.exclusive ? member < max.value : member <= max.value;
  return aboveMin && belowMax;
}

export function normalizeKeys(keys: readonly unknown[]): string[] {
  return (Array.isArray(keys[0]) ? keys[0] : keys) as string[];
}

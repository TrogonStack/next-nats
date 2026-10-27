import { invalidArgument } from "./errors.js";

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const TRACE_ID_ZERO = "0".repeat(32);
const PARENT_ID_ZERO = "0".repeat(16);
const SIMPLE_KEY = /^[a-z][a-z0-9_\-*/]{0,255}$/;
const TENANT_KEY = /^[a-z0-9][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13}$/;
const VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;
const MAX_MEMBERS = 32;
const MAX_TRACESTATE_LENGTH = 512;

const DOMAIN = "next-nats.trace";

function invalid(reason: string, message: string) {
  return invalidArgument(DOMAIN, reason, message);
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  do {
    globalThis.crypto.getRandomValues(buffer);
  } while (buffer.every((b) => b === 0));
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeTracestate(value: string): string {
  const members: string[] = [];
  const keys = new Set<string>();
  for (const raw of value.split(",")) {
    const member = raw.trim();
    if (member.length === 0) continue;
    const eq = member.indexOf("=");
    const key = eq < 0 ? "" : member.slice(0, eq);
    const val = eq < 0 ? "" : member.slice(eq + 1);
    if (!SIMPLE_KEY.test(key) && !TENANT_KEY.test(key)) {
      throw invalid("INVALID_TRACESTATE", `Invalid tracestate key in "${member}"`);
    }
    if (!VALUE.test(val)) throw invalid("INVALID_TRACESTATE", `Invalid tracestate value for key "${key}"`);
    if (keys.has(key)) throw invalid("INVALID_TRACESTATE", `Duplicate tracestate key "${key}"`);
    keys.add(key);
    members.push(`${key}=${val}`);
  }
  if (members.length > MAX_MEMBERS) {
    throw invalid("INVALID_TRACESTATE", `tracestate allows at most ${MAX_MEMBERS} members`);
  }
  const out = members.join(",");
  if (out.length > MAX_TRACESTATE_LENGTH) {
    throw invalid("INVALID_TRACESTATE", `tracestate is longer than ${MAX_TRACESTATE_LENGTH} characters`);
  }
  return out;
}

export interface TraceContextInit {
  traceId?: string;
  parentId?: string;
  sampled?: boolean;
  tracestate?: string;
}

export class TraceContext {
  readonly traceId: string;
  readonly parentId: string;
  readonly flags: number;
  readonly tracestate: string | undefined;

  private constructor(traceId: string, parentId: string, flags: number, tracestate: string | undefined) {
    this.traceId = traceId;
    this.parentId = parentId;
    this.flags = flags;
    this.tracestate = tracestate;
  }

  static generate(init: TraceContextInit = {}): TraceContext {
    const traceId = init.traceId ?? randomHex(16);
    const parentId = init.parentId ?? randomHex(8);
    if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === TRACE_ID_ZERO) {
      throw invalid("INVALID_TRACE_ID", `Invalid trace id "${traceId}"`);
    }
    if (!/^[0-9a-f]{16}$/.test(parentId) || parentId === PARENT_ID_ZERO) {
      throw invalid("INVALID_PARENT_ID", `Invalid parent id "${parentId}"`);
    }
    const tracestate = init.tracestate ? normalizeTracestate(init.tracestate) || undefined : undefined;
    return new TraceContext(traceId, parentId, init.sampled === false ? 0 : 1, tracestate);
  }

  static parse(traceparent: string, tracestate?: string): TraceContext {
    const match = TRACEPARENT.exec(traceparent.trim());
    if (!match) throw invalid("INVALID_TRACEPARENT", `Invalid traceparent "${traceparent}"`);
    const [, version, traceId, parentId, flags, extra] = match;
    if (version === "ff") throw invalid("INVALID_TRACEPARENT", "traceparent version ff is not allowed");
    if (version === "00" && extra !== undefined) {
      throw invalid("INVALID_TRACEPARENT", "traceparent version 00 does not allow extra fields");
    }
    if (version !== "00" && extra !== undefined && !extra.startsWith("-")) {
      throw invalid("INVALID_TRACEPARENT", `Invalid traceparent "${traceparent}"`);
    }
    if (traceId === TRACE_ID_ZERO) throw invalid("INVALID_TRACE_ID", "traceparent trace id must not be all zeros");
    if (parentId === PARENT_ID_ZERO) throw invalid("INVALID_PARENT_ID", "traceparent parent id must not be all zeros");
    const state = tracestate ? normalizeTracestate(tracestate) || undefined : undefined;
    return new TraceContext(traceId!, parentId!, Number.parseInt(flags!, 16), state);
  }

  static tryParse(traceparent: string, tracestate?: string): TraceContext | undefined {
    try {
      return TraceContext.parse(traceparent, tracestate);
    } catch {
      return undefined;
    }
  }

  static fromHeaders(headers: { get(key: string): string } | undefined): TraceContext | undefined {
    const traceparent = headers?.get("traceparent");
    if (!traceparent) return undefined;
    return TraceContext.tryParse(traceparent, headers?.get("tracestate") || undefined);
  }

  get sampled(): boolean {
    return (this.flags & 1) === 1;
  }

  get traceparent(): string {
    return `00-${this.traceId}-${this.parentId}-${this.flags.toString(16).padStart(2, "0")}`;
  }

  child(): TraceContext {
    return new TraceContext(this.traceId, randomHex(8), this.flags, this.tracestate);
  }

  withTracestate(tracestate: string | undefined): TraceContext {
    return new TraceContext(
      this.traceId,
      this.parentId,
      this.flags,
      tracestate ? normalizeTracestate(tracestate) || undefined : undefined,
    );
  }

  equals(other: TraceContext): boolean {
    return this.traceparent === other.traceparent && this.tracestate === other.tracestate;
  }

  toString(): string {
    return this.traceparent;
  }
}

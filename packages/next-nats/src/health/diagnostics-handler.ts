import "server-only";
import { authMode, getConnectionState, getNatsConfig, peekNats, type ConnectionState } from "../connection.js";
import { collectDiagnostics } from "../diagnostics.js";

export interface DiagnosticsOptions {
  rttTimeoutMs?: number;
  state?: () => ConnectionState;
}

export interface JetStreamDiagnostics {
  available: boolean;
  streams?: number;
  consumers?: number;
  memory?: number;
  storage?: number;
}

export interface DiagnosticsBody {
  connected: boolean;
  status: ConnectionState["phase"];
  server?: string;
  auth: { mode: string };
  rttMs: number | null;
  jetstream: JetStreamDiagnostics | null;
  diagnostics: Record<string, unknown>;
}

export const DEFAULT_RTT_TIMEOUT_MS = 2_000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function jetStreamDiagnostics(jsm: NonNullable<ReturnType<typeof peekNats>>["jsm"], ms: number): Promise<JetStreamDiagnostics | null> {
  try {
    const info = await withTimeout(jsm.getAccountInfo(), ms);
    if (!info) return null;
    return { available: true, streams: info.streams, consumers: info.consumers, memory: info.memory, storage: info.storage };
  } catch (error) {
    return error instanceof Error && error.name === "JetStreamNotEnabled" ? { available: false } : null;
  }
}

export async function collectDiagnosticsBody(options: DiagnosticsOptions = {}): Promise<DiagnosticsBody> {
  const { rttTimeoutMs = DEFAULT_RTT_TIMEOUT_MS, state = getConnectionState } = options;
  const phase = state().phase;
  const nats = peekNats();
  const connected = phase === "connected" && nats !== undefined && !nats.nc.isClosed();
  const [rttMs, jetstream, diagnostics] = await Promise.all([
    connected ? withTimeout(nats.nc.rtt(), rttTimeoutMs).catch(() => undefined) : undefined,
    connected ? jetStreamDiagnostics(nats.jsm, rttTimeoutMs) : null,
    collectDiagnostics(),
  ]);
  return {
    connected,
    status: phase,
    ...(connected && { server: nats.nc.getServer() }),
    auth: { mode: authMode(getNatsConfig()) },
    rttMs: rttMs ?? null,
    jetstream,
    diagnostics,
  };
}

export function createDiagnosticsHandler(options: DiagnosticsOptions = {}) {
  return async function GET(_request?: Request): Promise<Response> {
    const body = await collectDiagnosticsBody(options);
    return Response.json(body, { status: body.connected ? 200 : 503, headers: { "cache-control": "no-store" } });
  };
}

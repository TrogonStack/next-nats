import "server-only";
import { getConnectionState, type ConnectionState } from "../connection.js";

export interface HealthCheck {
  name: string;
  pass: boolean;
}

export interface ReadinessOptions {
  graceMs?: number;
  now?: () => number;
}

export interface LivenessOptions {
  state?: () => ConnectionState;
}

export const DEFAULT_READINESS_GRACE_MS = 5_000;

export function readinessChecks(
  state: ConnectionState = getConnectionState(),
  { graceMs = DEFAULT_READINESS_GRACE_MS, now = Date.now }: ReadinessOptions = {},
): HealthCheck[] {
  const connected =
    state.phase === "connected" || (state.phase === "reconnecting" && now() - state.since <= graceMs);
  return [
    { name: "shutdown", pass: !state.shuttingDown },
    { name: "connection", pass: connected },
  ];
}

export function livenessChecks(state: ConnectionState = getConnectionState()): HealthCheck[] {
  return [{ name: "initialization", pass: !state.initializing }];
}

function respond(checks: HealthCheck[], request: Request | undefined, failure: string): Response {
  const healthy = checks.every((check) => check.pass);
  const verbose = request ? new URL(request.url).searchParams.has("verbose") : false;
  const body = verbose
    ? checks.map((check) => `${check.name}: ${check.pass ? "pass" : "fail"}`).join("\n")
    : healthy
      ? "ok"
      : failure;
  return new Response(body, {
    status: healthy ? 200 : 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export function createReadinessHandler(options: ReadinessOptions = {}) {
  return function GET(request?: Request): Response {
    return respond(readinessChecks(getConnectionState(), options), request, "not ready");
  };
}

export function createLivenessHandler(options: LivenessOptions = {}) {
  const state = options.state ?? getConnectionState;
  return function GET(request?: Request): Response {
    return respond(livenessChecks(state()), request, "not alive");
  };
}

export {
  collectDiagnosticsBody,
  createDiagnosticsHandler,
  DEFAULT_RTT_TIMEOUT_MS,
  type DiagnosticsBody,
  type DiagnosticsOptions,
  type JetStreamDiagnostics,
} from "./diagnostics-handler.js";

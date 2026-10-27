import "server-only";
import {
  AgentService,
  type AgentServiceExtraEndpoint,
  type PromptHandler,
  type RequestInterceptor,
} from "@synadia-ai/agent-service";
import { Agents, formatHumanBytes, parseHumanBytes, type Logger as AgentsLogger } from "@synadia-ai/agents";
import { getNatsConfig, getNats, onNatsShutdown } from "../connection.js";
import { registerDiagnostics } from "../diagnostics.js";
import { getLogger } from "../logger.js";
import { agentIdentity, type AgentIdentity } from "./identity.js";

export type AgentStatus = "starting" | "running" | "stopped" | "error";

export interface AgentDefinition {
  agent: string;
  owner: string;
  name: string;
  subjectToken?: string;
  session?: string;
  description?: string;
  version?: string;
  heartbeatIntervalS?: number;
  keepaliveIntervalS?: number | null;
  attachmentsOk?: boolean;
  maxPayload?: number | string;
  extraMetadata?: Readonly<Record<string, string>>;
  extraEndpoints?: ReadonlyArray<AgentServiceExtraEndpoint>;
  interceptors?: ReadonlyArray<RequestInterceptor>;
  heartbeatExtras?: () => Readonly<Record<string, unknown>>;
  onPrompt: PromptHandler;
  onError?: (error: unknown) => void;
}

export interface ActiveAgent {
  readonly identity: AgentIdentity;
  stop(): Promise<void>;
  status(): AgentStatus;
}

export interface AgentStatusSnapshot {
  agent: string;
  owner: string;
  name: string;
  subject: string;
  status: AgentStatus;
  instanceId?: string;
  error?: string;
}

interface Entry {
  active: ActiveAgent;
  snapshot(): AgentStatusSnapshot;
}

interface State {
  agents: Map<string, Entry>;
  caller?: Agents;
  hook?: () => void;
  unregisterDiagnostics?: () => void;
}

const STATE_KEY = Symbol.for("next-nats.agents");

function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[STATE_KEY] ??= { agents: new Map() });
}

function ensureHook(): void {
  const s = state();
  if (s.hook) return;
  s.hook = onNatsShutdown(() => stopAllAgents(), { stage: "agents" });
}

function ensureDiagnostics(): void {
  const s = state();
  if (s.unregisterDiagnostics) return;
  s.unregisterDiagnostics = registerDiagnostics("agents", () => ({ agents: getAgentStatuses() }));
}

function dropDiagnosticsWhenEmpty(): void {
  const s = state();
  if (s.agents.size > 0) return;
  s.unregisterDiagnostics?.();
  s.unregisterDiagnostics = undefined;
}

function clampedMaxPayload(requested: number | string | undefined, serverMax: number | undefined): string | undefined {
  if (requested === undefined) return undefined;
  const bytes = typeof requested === "number" ? requested : parseHumanBytes(requested);
  const limit = serverMax && serverMax > 0 ? serverMax : undefined;
  return formatHumanBytes(limit ? Math.min(bytes, limit) : bytes);
}

function agentsLogger(): AgentsLogger {
  const log = getLogger();
  return {
    debug: (message, context) => log.debug(message, context),
    info: (message, context) => log.info(message, context),
    warn: (message, context) => log.warning(message, context),
    error: (message, context) => log.error(message, context),
  };
}

export function defineAgent(def: AgentDefinition): ActiveAgent {
  const identity = agentIdentity(def);
  const key = identity.promptSubject;

  const existing = state().agents.get(key);
  if (existing) return existing.active;

  if (!getNatsConfig().workers) {
    getLogger().info("agent not started: workers are disabled", { subject: key });
    return { identity, status: () => "stopped", stop: async () => {} };
  }

  let status: AgentStatus = "starting";
  let failure: string | undefined;
  let service: AgentService | undefined;
  let stopping: Promise<void> | undefined;

  const start = async () => {
    const { nc } = await getNats();
    const created = new AgentService({
      nc,
      agent: identity.agent,
      owner: identity.owner,
      name: identity.name,
      subjectToken: identity.subjectToken,
      logger: agentsLogger(),
      ...(def.session !== undefined && { session: def.session }),
      ...(def.description !== undefined && { description: def.description }),
      ...(def.version !== undefined && { version: def.version }),
      ...(def.heartbeatIntervalS !== undefined && { heartbeatIntervalS: def.heartbeatIntervalS }),
      ...(def.keepaliveIntervalS !== undefined && { keepaliveIntervalS: def.keepaliveIntervalS }),
      ...(def.attachmentsOk !== undefined && { attachmentsOk: def.attachmentsOk }),
      ...(def.maxPayload !== undefined && { maxPayload: clampedMaxPayload(def.maxPayload, nc.info?.max_payload) }),
      ...(def.extraMetadata && { extraMetadata: def.extraMetadata }),
      ...(def.extraEndpoints && { extraEndpoints: def.extraEndpoints }),
      ...(def.interceptors && { interceptors: def.interceptors }),
      ...(def.heartbeatExtras && { heartbeatExtras: def.heartbeatExtras }),
    });
    created.onPrompt(def.onPrompt);
    if (stopping) return;
    await created.start();
    service = created;
    if (stopping) await created.stop().catch(() => undefined);
    else status = "running";
  };

  const started = start().catch((error: unknown) => {
    if (stopping) return;
    status = "error";
    failure = error instanceof Error ? error.message : String(error);
    getLogger().error("agent failed to start", { subject: key, error });
    def.onError?.(error);
  });

  const active: ActiveAgent = {
    identity,
    status: () => status,
    stop() {
      stopping ??= (async () => {
        const s = state();
        if (s.agents.get(key)?.active === active) s.agents.delete(key);
        dropDiagnosticsWhenEmpty();
        await started;
        status = "stopped";
        await service?.stop().catch((error: unknown) => getLogger().warning("agent stop failed", { subject: key, error }));
      })();
      return stopping;
    },
  };

  state().agents.set(key, {
    active,
    snapshot: () => ({
      agent: identity.agent,
      owner: identity.owner,
      name: identity.name,
      subject: key,
      status,
      ...(service && status === "running" && { instanceId: service.instanceId }),
      ...(failure && { error: failure }),
    }),
  });
  ensureHook();
  ensureDiagnostics();
  return active;
}

export function getAgentStatuses(): AgentStatusSnapshot[] {
  return [...state().agents.values()].map((entry) => entry.snapshot());
}

export async function stopAllAgents(): Promise<void> {
  const s = state();
  await Promise.all([...s.agents.values()].map((entry) => entry.active.stop()));
  const caller = s.caller;
  s.caller = undefined;
  await caller?.close().catch(() => undefined);
}

export async function getAgents(): Promise<Agents> {
  const s = state();
  if (s.caller && !s.caller.isClosed && !s.caller.connection.isClosed()) return s.caller;
  const { nc } = await getNats();
  if (s.caller && !s.caller.isClosed && !s.caller.connection.isClosed()) return s.caller;
  s.caller = new Agents({ nc, logger: agentsLogger() });
  ensureHook();
  return s.caller;
}

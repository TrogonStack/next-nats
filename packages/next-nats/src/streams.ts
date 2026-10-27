import "server-only";
import {
  JetStreamApiCodes,
  JetStreamApiError,
  type Placement,
  type StreamConfig,
  type StreamInfo,
} from "@nats-io/jetstream";
import { defaultMaxBytes, getNats } from "./connection.js";
import { duration, type DurationInput } from "./duration.js";
import { failedPrecondition, invalidArgument } from "./errors.js";
import { streamName, subject } from "./values.js";

export const ProvisionMode = {
  Never: "never",
  Startup: "startup",
  Update: "update",
} as const;
export type ProvisionMode = (typeof ProvisionMode)[keyof typeof ProvisionMode];

const PROVISION_MODES: readonly string[] = Object.values(ProvisionMode);

export function provisionMode(value: string): ProvisionMode {
  if (!PROVISION_MODES.includes(value)) {
    throw invalidArgument(
      "next-nats.streams",
      "INVALID_PROVISION_MODE",
      `Invalid provision mode "${value}": use ${PROVISION_MODES.map((m) => `"${m}"`).join(", ")}`,
    );
  }
  return value as ProvisionMode;
}

export interface StreamPlacement {
  cluster?: string;
  tags?: string[];
}

export type StreamSpec = Partial<Omit<StreamConfig, "name" | "placement">> & {
  name: string;
  maxAge?: DurationInput;
  duplicateWindow?: DurationInput;
  replicas?: number;
  maxBytes?: number;
  placement?: StreamPlacement;
};

export function toStreamConfig(spec: StreamSpec): Partial<StreamConfig> & { name: string } {
  const { maxAge, duplicateWindow, replicas, maxBytes, placement, name, ...rest } = spec;
  const config: Partial<StreamConfig> & { name: string } = { ...(rest as Partial<StreamConfig>), name: streamName(name) };
  if (rest.subjects !== undefined) config.subjects = rest.subjects.map(subject);
  if (maxAge !== undefined) config.max_age = duration(maxAge).toNanos();
  if (duplicateWindow !== undefined) config.duplicate_window = duration(duplicateWindow).toNanos();
  if (replicas !== undefined) {
    if (!Number.isInteger(replicas) || replicas < 1 || replicas > 5) {
      throw invalidArgument("next-nats.streams", "INVALID_REPLICAS", `replicas must be an integer from 1 to 5, got ${replicas}`);
    }
    config.num_replicas = replicas;
  }
  if (maxBytes !== undefined) config.max_bytes = maxBytes;
  if (placement !== undefined) {
    config.placement = {
      ...(placement.cluster !== undefined && { cluster: placement.cluster }),
      ...(placement.tags !== undefined && { tags: placement.tags }),
    } as Placement;
  }
  return config;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

export function streamDrift(current: Partial<StreamConfig>, desired: Partial<StreamConfig>): string[] {
  const drift: string[] = [];
  for (const [key, want] of Object.entries(desired)) {
    if (want === undefined) continue;
    const have = (current as Record<string, unknown>)[key];
    const a = key === "subjects" && Array.isArray(have) ? [...have].sort() : have;
    const b = key === "subjects" && Array.isArray(want) ? [...want].sort() : want;
    if (JSON.stringify(normalize(a)) !== JSON.stringify(normalize(b))) drift.push(key);
  }
  return drift;
}

async function findStream(name: string): Promise<StreamInfo | undefined> {
  const { jsm } = await getNats();
  try {
    return await jsm.streams.info(name);
  } catch (err) {
    if (err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound) return undefined;
    throw err;
  }
}

function withDefaultMaxBytes<T extends Partial<StreamConfig>>(config: T): T {
  const maxBytes = defaultMaxBytes();
  return config.max_bytes === undefined && maxBytes !== undefined ? { ...config, max_bytes: maxBytes } : config;
}

export async function ensureStream(spec: StreamSpec): Promise<StreamInfo> {
  const config = toStreamConfig(spec);
  const { jsm } = await getNats();
  const existing = await findStream(config.name);
  if (!existing) return jsm.streams.add(withDefaultMaxBytes(config));
  if (streamDrift(existing.config, config).length === 0) return existing;
  return jsm.streams.update(config.name, config);
}

export interface StreamDefinition {
  readonly spec: StreamSpec;
  readonly name: string;
  readonly provision: ProvisionMode;
  ensure(): Promise<StreamInfo>;
}

export interface DefineStreamOptions {
  provision?: ProvisionMode | `${ProvisionMode}`;
}

export function defineStream(spec: StreamSpec, opts: DefineStreamOptions = {}): StreamDefinition {
  const mode = provisionMode(opts.provision ?? ProvisionMode.Startup);
  const name = streamName(spec.name);
  toStreamConfig(spec);
  return {
    spec,
    name,
    provision: mode,
    async ensure() {
      if (mode === ProvisionMode.Update) return ensureStream(spec);
      const existing = await findStream(name);
      if (existing) return existing;
      if (mode === ProvisionMode.Never) {
        throw failedPrecondition("next-nats.streams", "STREAM_MISSING", `Stream "${name}" does not exist and its provision mode is "never"`);
      }
      const { jsm } = await getNats();
      return jsm.streams.add(withDefaultMaxBytes(toStreamConfig(spec)));
    },
  };
}

export function ensureStreamOnce(spec: StreamSpec): () => Promise<StreamInfo> {
  let ready: Promise<StreamInfo> | undefined;
  return () =>
    (ready ??= ensureStream(spec).catch((error) => {
      ready = undefined;
      throw error;
    }));
}

export interface UntilStreamExistsOptions {
  subjects?: readonly string[];
  signal?: AbortSignal;
  pollMs?: number;
}

const STREAM_POLL_MS = 30_000;
const STREAM_RECHECK_MS = 1_000;

export async function untilStreamExists(name: string, opts: UntilStreamExistsOptions = {}): Promise<void> {
  if (await findStream(name)) return;
  const { nc } = await getNats();
  const subscriptions = (opts.subjects ?? []).map((subj) => nc.subscribe(subj));
  let wake: () => void = () => undefined;
  let woken = new Promise<void>((resolve) => (wake = resolve));
  for (const sub of subscriptions) {
    void (async () => {
      for await (const _ of sub) wake();
    })().catch(() => undefined);
  }
  opts.signal?.addEventListener("abort", () => wake(), { once: true });
  try {
    while (!opts.signal?.aborted) {
      let timer: NodeJS.Timeout | undefined;
      const tick = new Promise<void>((resolve) => (timer = setTimeout(resolve, opts.pollMs ?? STREAM_POLL_MS)));
      timer?.unref();
      await Promise.race([woken, tick]);
      clearTimeout(timer);
      woken = new Promise<void>((resolve) => (wake = resolve));
      if (opts.signal?.aborted || (await findStream(name))) return;
      await new Promise((resolve) => setTimeout(resolve, STREAM_RECHECK_MS).unref());
    }
  } finally {
    for (const sub of subscriptions) sub.unsubscribe();
  }
}

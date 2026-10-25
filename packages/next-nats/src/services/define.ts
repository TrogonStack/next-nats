import "server-only";
import { headers as natsHeaders, type MsgHdrs } from "@nats-io/nats-core";
import { Svcm, type Service, type ServiceMsg } from "@nats-io/services";
import { codec } from "../codec.js";
import { getNatsConfig, getNats, onNatsShutdown } from "../connection.js";
import { httpStatusOf, SpecError, toSpecError, Visibility, type PublicErrorBody } from "../errors.js";
import { getLogger } from "../logger.js";
import { EndpointError } from "./errors.js";
import { runParser, type Parser } from "./schema.js";

export const SERVICE_INSTANCE_HEADER = "Nats-Service-Instance";

export interface EndpointContext {
  readonly service: string;
  readonly endpoint: string;
  readonly instance: string;
  readonly subject: string;
  readonly headers?: MsgHdrs;
}

export interface EndpointDefinition<I = any, O = any> {
  subject?: string;
  queue?: string;
  metadata?: Record<string, string>;
  input?: Parser<I>;
  output?: Parser<O>;
  handler: (input: I, ctx: EndpointContext) => O | Promise<O>;
}

export type EndpointMap = Record<string, EndpointDefinition>;

export interface ServiceConfigInput<E extends EndpointMap> {
  name: string;
  version: string;
  description?: string;
  metadata?: Record<string, string>;
  queue?: string;
  instances?: number;
  endpoints: E;
  onError?: (error: unknown, ctx: Pick<EndpointContext, "service" | "endpoint" | "instance">) => void;
}

export interface ServiceDefinition<E extends EndpointMap = EndpointMap> {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly endpoints: E;
  readonly running: boolean;
  subjectOf(endpoint: keyof E & string): string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function endpoint<I, O>(definition: EndpointDefinition<I, O>): EndpointDefinition<I, O> {
  return definition;
}

interface EndpointFailures {
  errors: number;
  lastError?: string;
  lastErrorCode?: number;
}

const REGISTRY_KEY = Symbol.for("next-nats.services");

function registry(): Map<string, ServiceDefinition> {
  const g = globalThis as unknown as Record<symbol, Map<string, ServiceDefinition> | undefined>;
  return (g[REGISTRY_KEY] ??= new Map());
}

export function endpointSubject(service: string, endpointName: string, override?: string): string {
  return override ?? `${service}.${endpointName}`;
}

function failureOf(error: unknown): { source: SpecError; status: number; body: PublicErrorBody } {
  const source = toSpecError(error);
  const body = source.toPublic(Visibility.PRIVATE);
  if (source.spec.visibility < Visibility.PRIVATE) return { source, status: 500, body };
  const status = error instanceof EndpointError ? error.code : httpStatusOf(source.spec.code);
  return { source, status, body };
}

async function dispatch(
  def: EndpointDefinition,
  ctx: EndpointContext,
  msg: ServiceMsg,
  failures: EndpointFailures,
  onError: ServiceConfigInput<EndpointMap>["onError"],
): Promise<void> {
  const reply = natsHeaders();
  reply.set(SERVICE_INSTANCE_HEADER, ctx.instance);
  try {
    let raw: unknown;
    if (msg.data.length > 0) {
      try {
        raw = codec.decodeJson(msg.data);
      } catch {
        throw new EndpointError(400, "Request body is not valid JSON");
      }
    }
    const input = def.input ? await runParser(def.input, raw) : raw;
    let output = await def.handler(input, ctx);
    if (def.output) output = await runParser(def.output, output);
    msg.respond(output === undefined ? undefined : codec.encodeJson(output), { headers: reply });
  } catch (error) {
    const { source, status, body } = failureOf(error);
    failures.errors += 1;
    failures.lastError = body.message;
    failures.lastErrorCode = status;
    const context = { service: ctx.service, endpoint: ctx.endpoint, errorId: source.spec.id, error };
    if (status >= 500) {
      getLogger().error("service endpoint failed", context);
      onError?.(error, ctx);
    } else {
      getLogger().debug("service endpoint rejected a request", context);
    }
    msg.respondError(status, body.message, codec.encodeJson(body), { headers: reply });
  }
}

export function defineService<const E extends EndpointMap>(config: ServiceConfigInput<E>): ServiceDefinition<E> {
  const existing = registry().get(config.name);
  if (existing) return existing as unknown as ServiceDefinition<E>;

  const instances = Math.max(1, config.instances ?? 1);
  let running: Service[] = [];
  let starting: Promise<void> | undefined;

  const names = Object.keys(config.endpoints);

  const spawn = async (svcm: Svcm): Promise<Service> => {
    const failures = new Map<string, EndpointFailures>(names.map((n) => [n, { errors: 0 }]));
    const bySubject = new Map(
      names.map((n) => [endpointSubject(config.name, n, config.endpoints[n]!.subject), failures.get(n)!]),
    );
    const svc = await svcm.add({
      name: config.name,
      version: config.version,
      description: config.description,
      metadata: config.metadata,
      ...(config.queue !== undefined && { queue: config.queue }),
      statsHandler: async (ep) => bySubject.get(ep.subject) ?? null,
    });
    for (const name of names) {
      const def = config.endpoints[name]!;
      const subject = endpointSubject(config.name, name, def.subject);
      svc.addEndpoint(name, {
        subject,
        queue: def.queue,
        metadata: def.metadata,
        handler: (err, msg) => {
          if (err) return;
          const ctx: EndpointContext = {
            service: config.name,
            endpoint: name,
            instance: svc.info().id,
            subject: msg.subject,
            headers: msg.headers,
          };
          void dispatch(def, ctx, msg, failures.get(name)!, config.onError);
        },
      });
    }
    return svc;
  };

  const definition: ServiceDefinition<E> = {
    name: config.name,
    version: config.version,
    description: config.description,
    endpoints: config.endpoints,
    get running() {
      return running.length > 0;
    },
    subjectOf(name) {
      return endpointSubject(config.name, name, config.endpoints[name]?.subject);
    },
    start() {
      starting ??= (async () => {
        const { nc } = await getNats();
        const svcm = new Svcm(nc);
        const started: Service[] = [];
        for (let i = 0; i < instances; i++) started.push(await spawn(svcm));
        running = started;
      })().catch((error) => {
        starting = undefined;
        throw error;
      });
      return starting;
    },
    async stop() {
      await starting?.catch(() => undefined);
      const stopping = running;
      running = [];
      starting = undefined;
      await Promise.all(stopping.map((s) => s.stop().catch(() => undefined)));
    },
  };

  registry().set(config.name, definition as unknown as ServiceDefinition);
  onNatsShutdown(() => definition.stop());

  if (getNatsConfig().workers) {
    definition.start().catch((error) => getLogger().error(`service "${config.name}" failed to start`, { error }));
  }
  return definition;
}

export async function stopAllServices(): Promise<void> {
  await Promise.all([...registry().values()].map((s) => s.stop()));
}

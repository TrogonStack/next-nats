import "server-only";
import { headers as natsHeaders, RequestError, TimeoutError, type Msg } from "@nats-io/nats-core";
import { ServiceError } from "@nats-io/services";
import { codec } from "../codec.js";
import { getNats } from "../connection.js";
import { endpointSubject, SERVICE_INSTANCE_HEADER, type EndpointDefinition, type EndpointMap, type ServiceDefinition } from "./define.js";
import { ServiceCallError } from "./errors.js";

export interface CallOptions {
  timeout?: number;
  headers?: Record<string, string>;
  traceparent?: string;
}

export interface GatherOptions extends CallOptions {
  maxWait?: number;
  maxMessages?: number;
}

export type GatherResult<O> =
  | { ok: true; instance?: string; value: O }
  | { ok: false; instance?: string; error: ServiceCallError };

type CallArgs<I> = undefined extends I ? [input?: I, opts?: CallOptions] : [input: I, opts?: CallOptions];
type GatherArgs<I> = undefined extends I ? [input?: I, opts?: GatherOptions] : [input: I, opts?: GatherOptions];

export type EndpointClient<I, O> = ((...args: CallArgs<I>) => Promise<O>) & {
  gather: (...args: GatherArgs<I>) => Promise<GatherResult<O>[]>;
  readonly subject: string;
};

export type ServiceClientOf<S> = S extends ServiceDefinition<infer E>
  ? { [K in keyof E]: E[K] extends EndpointDefinition<infer I, infer O> ? EndpointClient<I, Awaited<O>> : never }
  : Record<string, EndpointClient<any, any>>;

export interface ServiceClientOptions<S> extends CallOptions {
  subjects?: S extends ServiceDefinition<infer E> ? Partial<Record<keyof E & string, string>> : Record<string, string>;
}

function buildHeaders(opts: CallOptions) {
  if (!opts.headers && !opts.traceparent) return undefined;
  const h = natsHeaders();
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v);
  if (opts.traceparent) h.set("traceparent", opts.traceparent);
  return h;
}

function decodeReply(msg: Msg): unknown {
  return msg.data.length === 0 ? undefined : codec.decodeJson(msg.data);
}

export function serviceClient<S extends ServiceDefinition<any> = ServiceDefinition<any>>(
  service: string | S,
  clientOpts: ServiceClientOptions<S> = {},
): ServiceClientOf<S> {
  const name = typeof service === "string" ? service : service.name;
  const subjects = (clientOpts.subjects ?? {}) as Record<string, string | undefined>;
  const cache = new Map<string, EndpointClient<any, any>>();

  const subjectFor = (ep: string): string => {
    const override = subjects[ep];
    if (override) return override;
    if (typeof service !== "string") return service.subjectOf(ep);
    return endpointSubject(name, ep);
  };

  const build = (ep: string): EndpointClient<any, any> => {
    const subject = subjectFor(ep);
    const fail = (init: ConstructorParameters<typeof ServiceCallError>[0], cause?: unknown) =>
      new ServiceCallError(init, { cause });
    const base = { service: name, endpoint: ep, subject };

    const mapRequestError = (error: unknown): ServiceCallError => {
      if (error instanceof ServiceCallError) return error;
      if (error instanceof RequestError) {
        if (error.isNoResponders()) {
          return fail({ ...base, code: 503, kind: "unavailable", message: `No responders for ${subject}` }, error);
        }
        if (error.cause instanceof TimeoutError) {
          return fail({ ...base, code: 408, kind: "timeout", message: `Request to ${subject} timed out` }, error);
        }
      }
      if (error instanceof TimeoutError) {
        return fail({ ...base, code: 408, kind: "timeout", message: `Request to ${subject} timed out` }, error);
      }
      throw error;
    };

    const toError = (msg: Msg): ServiceCallError | undefined => {
      const failure = ServiceError.toServiceError(msg);
      return failure ? fail({ ...base, code: failure.code, kind: "service", message: failure.message }, failure) : undefined;
    };

    const call = async (input?: unknown, opts: CallOptions = {}): Promise<unknown> => {
      const merged = { ...clientOpts, ...opts };
      const { nc } = await getNats();
      let reply: Msg;
      try {
        reply = await nc.request(subject, input === undefined ? undefined : codec.encodeJson(input), {
          timeout: merged.timeout ?? 5_000,
          headers: buildHeaders(merged),
        });
      } catch (error) {
        throw mapRequestError(error);
      }
      const failure = toError(reply);
      if (failure) throw failure;
      return decodeReply(reply);
    };

    const gather = async (input?: unknown, opts: GatherOptions = {}): Promise<GatherResult<unknown>[]> => {
      const merged = { ...clientOpts, ...opts };
      const { nc } = await getNats();
      const results: GatherResult<unknown>[] = [];
      try {
        const replies = await nc.requestMany(subject, input === undefined ? undefined : codec.encodeJson(input), {
          strategy: merged.maxMessages ? "count" : "timer",
          maxWait: merged.maxWait ?? merged.timeout ?? 1_000,
          maxMessages: merged.maxMessages,
          headers: buildHeaders(merged),
        });
        for await (const msg of replies) {
          const instance = msg.headers?.get(SERVICE_INSTANCE_HEADER) || undefined;
          const failure = toError(msg);
          if (failure) results.push({ ok: false, instance, error: failure });
          else results.push({ ok: true, instance, value: decodeReply(msg) });
        }
      } catch (error) {
        throw mapRequestError(error);
      }
      return results;
    };

    return Object.assign(call, { gather, subject }) as EndpointClient<any, any>;
  };

  return new Proxy({} as ServiceClientOf<S>, {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      let client = cache.get(prop);
      if (!client) {
        client = build(prop);
        cache.set(prop, client);
      }
      return client;
    },
  });
}

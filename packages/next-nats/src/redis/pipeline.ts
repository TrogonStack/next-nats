import { UpstashError } from "../kv/errors.js";
import { Redis, internals } from "./redis.js";

const HELPERS = new Set([
  "constructor",
  "pipeline",
  "transact",
  "multi",
  "createScript",
  "de",
  "load",
  "update",
  "setExpiry",
  "scanSlice",
  "sets",
  "diff",
  "inter",
  "union",
  "storeSet",
  "updateZ",
  "zload",
  "flatten",
  "pop",
  "zrangeImpl",
  "zpop",
  "combine",
  "storeZ",
]);

type CommandName = {
  [K in keyof Redis]: Redis[K] extends (...args: never[]) => unknown ? K : never;
}[keyof Redis] &
  string;

const UPPERCASE_ON_WIRE = new Set(["copy"]);

function wireName(name: string): string {
  return UPPERCASE_ON_WIRE.has(name) ? name.toUpperCase() : name;
}

export type PipelineCommandName = Exclude<CommandName, "pipeline" | "multi" | "createScript">;

type Chainable = { [K in PipelineCommandName]: (...args: Parameters<Redis[K]>) => Pipeline };

export interface ExecMethod {
  <TCommands extends unknown[] = unknown[]>(): Promise<TCommands>;
  <TCommands extends unknown[] = unknown[]>(options: { keepErrors: true }): Promise<{ error?: string; result: unknown }[] & { length: TCommands["length"] }>;
}

export interface Pipeline extends Chainable {
  exec: ExecMethod;
  length(): number;
}

let names: string[] | undefined;

export function commandNames(redis: Redis): string[] {
  names ??= (() => {
    const found = new Set<string>();
    for (let proto = Object.getPrototypeOf(redis) as object | null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (HELPERS.has(name) || found.has(name)) continue;
        if (typeof Object.getOwnPropertyDescriptor(proto, name)?.value === "function") found.add(name);
      }
    }
    return [...found].filter((n) => !n.endsWith("Iterator"));
  })();
  return names;
}

type Outcome = { error?: string; result: unknown; cause?: unknown };

class PipelineImpl {
  private readonly queue: Array<{ name: string; args: unknown[] }> = [];

  constructor(
    private readonly redis: Redis,
    readonly atomic: boolean,
  ) {}

  length(): number {
    return this.queue.length;
  }

  async exec(options?: { keepErrors: true }): Promise<unknown[]> {
    const queued = this.queue.splice(0);
    const run = async (target: Redis) => {
      const results: Outcome[] = [];
      const bare = Object.create(Redis.prototype, { [internals]: { value: target[internals] } }) as Redis;
      for (const { name, args } of queued) {
        const command = (Redis.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name] as (
          ...a: unknown[]
        ) => Promise<unknown>;
        try {
          results.push({ result: await command.apply(bare, args) });
        } catch (error) {
          if (this.atomic && !(error instanceof UpstashError)) throw error;
          results.push({ error: error instanceof Error ? error.message : String(error), result: null, cause: error });
        }
      }
      return results;
    };
    const results: Outcome[] = this.atomic
      ? await (this.redis as unknown as { transact: (fn: (r: Redis) => Promise<Outcome[]>) => Promise<Outcome[]> }).transact(run)
      : await run(this.redis);
    const failedIndex = results.findIndex((r) => r.error !== undefined);
    if (failedIndex >= 0 && !options?.keepErrors) {
      const cause = results[failedIndex]?.cause;
      if (!(cause instanceof UpstashError)) throw cause;
      throw new UpstashError(`Command ${failedIndex + 1} [ ${wireName(queued[failedIndex]?.name ?? "")} ] failed: ${cause.code}`, cause.spec.message);
    }
    return options?.keepErrors ? results.map(({ error, result }) => (error === undefined ? { result } : { error, result })) : results.map((r) => r.result);
  }

  push(name: string, args: unknown[]): this {
    this.queue.push({ name, args });
    return this;
  }
}

export function createPipeline(redis: Redis, atomic: boolean): Pipeline {
  const pipeline = new PipelineImpl(redis, atomic);
  for (const name of commandNames(redis)) {
    Object.defineProperty(pipeline, name, {
      value: (...args: unknown[]) => pipeline.push(name, args),
      enumerable: false,
    });
  }
  return pipeline as unknown as Pipeline;
}

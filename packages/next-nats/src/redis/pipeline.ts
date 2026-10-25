import type { Redis } from "./redis.js";

const HELPERS = new Set([
  "constructor",
  "pipeline",
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

function commandNames(redis: Redis): string[] {
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
    const results: Array<{ error?: string; result: unknown }> = [];
    for (const { name, args } of queued) {
      try {
        const run = (this.redis as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name] as (
          ...a: unknown[]
        ) => Promise<unknown>;
        results.push({ result: await run.apply(this.redis, args) });
      } catch (error) {
        if (!options?.keepErrors) throw error;
        results.push({ error: error instanceof Error ? error.message : String(error), result: null });
      }
    }
    return options?.keepErrors ? results : results.map((r) => r.result);
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

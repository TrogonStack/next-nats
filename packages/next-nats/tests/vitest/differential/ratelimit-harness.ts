import type { Pair } from "./redis-harness.js";

const UPSTASH_ONLY_FLAG = "#!lua flags=allow-key-locking";

export function openSourceRedis(real: Pair["real"]): Pair["real"] {
  return new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "eval") {
        return (script: string, keys: string[], args: unknown[]) => target.eval(script.replace(UPSTASH_ONLY_FLAG, "#!lua"), keys, args);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function withLatency(real: Pair["real"], ms: number): Pair["real"] {
  return new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "eval" || property === "evalsha") {
        return async (...args: unknown[]) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

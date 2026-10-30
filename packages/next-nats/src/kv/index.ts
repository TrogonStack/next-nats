import "server-only";
import { Redis } from "../redis/redis.js";
import type { RedisConfigNodejs, ScanCommandOptions } from "../redis/types.js";

export { decodeKey, encodeKey, globToRegExp } from "./key.js";
export type { KvKey } from "./key.js";
export { KvError, UpstashError } from "./errors.js";
export { KvStore } from "./store.js";
export type { KvRecord, KvStoreOptions } from "./store.js";

async function* iterate<T>(
  page: (cursor: string) => Promise<[string, T[]]>,
): AsyncGenerator<T, void, undefined> {
  let cursor = "0";
  do {
    const [next, items] = await page(cursor);
    yield* items;
    cursor = next;
  } while (cursor !== "0");
}

export class VercelKV extends Redis {
  scanIterator(options?: ScanCommandOptions): AsyncIterable<string> {
    return iterate<string>(async (cursor) => {
      const [next, keys] = await this.scan(cursor, options ?? {});
      return [next, keys as string[]];
    });
  }

  hscanIterator(key: string, options?: ScanCommandOptions): AsyncIterable<string | number> {
    return iterate((cursor) => this.hscan(key, cursor, options));
  }

  sscanIterator(key: string, options?: ScanCommandOptions): AsyncIterable<string | number> {
    return iterate((cursor) => this.sscan(key, cursor, options));
  }

  zscanIterator(key: string, options?: ScanCommandOptions): AsyncIterable<string | number> {
    return iterate((cursor) => this.zscan(key, cursor, options));
  }
}

export function createClient(config: RedisConfigNodejs): VercelKV {
  return new VercelKV({ ...config });
}

export const kv: VercelKV = /* @__PURE__ */ createClient({});

export default kv;

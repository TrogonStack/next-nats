import type { BatchOp, KvRecord, KvStore, Store } from "./store.js";

interface Observed {
  rev: number;
  rec: KvRecord | null;
}

export class Transaction implements Store {
  private readonly observed = new Map<string, Observed>();
  private readonly pending = new Map<string, { rec: KvRecord | null; expected: number | undefined }>();

  constructor(private readonly base: KvStore) {}

  get bucket(): string {
    return this.base.bucket;
  }

  get maxRetries(): number {
    return this.base.maxRetries;
  }

  get nativeTtl(): Promise<boolean> {
    return this.base.nativeTtl;
  }

  get atomic(): Promise<boolean> {
    return this.base.atomic;
  }

  get size(): number {
    return this.pending.size;
  }

  kv(): ReturnType<KvStore["kv"]> {
    return this.base.kv();
  }

  private async seen(key: string): Promise<Observed> {
    let found = this.observed.get(key);
    if (!found) {
      found = await this.base.read(key);
      this.observed.set(key, found);
    }
    return found;
  }

  async read(key: string): Promise<Observed> {
    const base = await this.seen(key);
    const staged = this.pending.get(key);
    return staged ? { rev: base.rev, rec: staged.rec } : base;
  }

  private stage(key: string, rec: KvRecord | null, rev: number | undefined): void {
    const expected = this.pending.get(key)?.expected ?? (this.observed.has(key) ? this.observed.get(key)?.rev : rev);
    this.pending.set(key, { rec, expected });
  }

  async write(key: string, rec: KvRecord, rev: number | undefined): Promise<boolean> {
    this.stage(key, rec, rev);
    return true;
  }

  async remove(key: string, rev: number): Promise<boolean> {
    this.stage(key, null, rev);
    return true;
  }

  async mutate<R>(
    key: string,
    fn: (current: KvRecord | null) => { next: KvRecord | null | undefined; result: R },
  ): Promise<R> {
    const { rev, rec } = await this.read(key);
    const { next, result } = fn(rec);
    if (next === undefined) return result;
    if (next === null) {
      if (rec !== null) this.stage(key, null, rev);
    } else this.stage(key, next, rev);
    return result;
  }

  async allKeys(): Promise<string[]> {
    const keys = new Set(await this.base.allKeys());
    for (const [key, { rec }] of this.pending) {
      if (rec) keys.add(key);
      else keys.delete(key);
    }
    return [...keys].sort();
  }

  flush(): Promise<boolean> {
    const ops: BatchOp[] = [...this.pending].map(([key, { rec, expected }]) => ({ key, rec, expected }));
    return this.base.commit(ops);
  }
}

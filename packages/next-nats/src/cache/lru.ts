export class ByteLru<V> {
  private readonly map = new Map<string, { value: V; size: number }>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: string, value: V, size: number): void {
    this.delete(key);
    if (size > this.maxBytes) return;
    this.map.set(key, { value, size });
    this.bytes += size;
    for (const [oldest, entry] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(oldest);
      this.bytes -= entry.size;
    }
  }

  delete(key: string): void {
    const hit = this.map.get(key);
    if (!hit) return;
    this.map.delete(key);
    this.bytes -= hit.size;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.map.size;
  }
}

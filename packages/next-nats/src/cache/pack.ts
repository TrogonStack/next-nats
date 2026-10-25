const BIN = "$bin";
const MAP = "$map";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function frameBytes(head: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + head.byteLength + body.byteLength);
  new DataView(out.buffer).setUint32(0, head.byteLength);
  out.set(head, 4);
  out.set(body, 4 + head.byteLength);
  return out;
}

export function unframeBytes(bytes: Uint8Array): { head: Uint8Array; body: Uint8Array } {
  const headLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return { head: bytes.subarray(4, 4 + headLength), body: bytes.subarray(4 + headLength) };
}

export function frame(header: unknown, body: Uint8Array): Uint8Array {
  return frameBytes(textEncoder.encode(JSON.stringify(header)), body);
}

export function unframe<H>(bytes: Uint8Array): { header: H; body: Uint8Array } {
  const { head, body } = unframeBytes(bytes);
  return { header: JSON.parse(textDecoder.decode(head)) as H, body };
}

export function pack(value: unknown): Uint8Array {
  const blobs: Uint8Array[] = [];
  let offset = 0;
  const json = JSON.stringify(value ?? null, function (this: Record<string, unknown>, key, replaced) {
    const original = this[key];
    if (original instanceof Uint8Array) {
      const ref = { [BIN]: [offset, original.byteLength] };
      blobs.push(original);
      offset += original.byteLength;
      return ref;
    }
    if (original instanceof Map) return { [MAP]: [...original.entries()] };
    return replaced;
  });
  const body = new Uint8Array(offset);
  let cursor = 0;
  for (const blob of blobs) {
    body.set(blob, cursor);
    cursor += blob.byteLength;
  }
  return frameBytes(textEncoder.encode(json), body);
}

export function unpack<T>(bytes: Uint8Array): T {
  const { head, body } = unframeBytes(bytes);
  return JSON.parse(textDecoder.decode(head), (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const bin = (value as Record<string, unknown>)[BIN];
      if (Array.isArray(bin)) {
        const [start, length] = bin as [number, number];
        return Buffer.from(body.subarray(start, start + length));
      }
      const map = (value as Record<string, unknown>)[MAP];
      if (Array.isArray(map)) return new Map(map as [unknown, unknown][]);
    }
    return value;
  }) as T;
}

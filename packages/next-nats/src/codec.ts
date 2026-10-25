const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const codec = {
  encode(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (typeof value === "string") return encoder.encode(value);
    return encoder.encode(JSON.stringify(value));
  },
  encodeJson(value: unknown): Uint8Array {
    return encoder.encode(JSON.stringify(value));
  },
  decodeText(data: Uint8Array): string {
    return decoder.decode(data);
  },
  decodeJson<T = unknown>(data: Uint8Array): T {
    return JSON.parse(decoder.decode(data)) as T;
  },
  tryDecodeJson<T = unknown>(data: Uint8Array): T | string {
    const text = decoder.decode(data);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text;
    }
  },
} as const;

export type Codec = typeof codec;

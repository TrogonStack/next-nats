import { invalidArgument } from "./errors.js";

const UNITS: Record<string, number> = {
  b: 1,
  k: 1_000,
  kb: 1_000,
  kib: 1_024,
  m: 1_000_000,
  mb: 1_000_000,
  mib: 1_048_576,
  g: 1_000_000_000,
  gb: 1_000_000_000,
  gib: 1_073_741_824,
  t: 1_000_000_000_000,
  tb: 1_000_000_000_000,
  tib: 1_099_511_627_776,
};

const SIZE = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/i;

export class ByteSize {
  readonly #bytes: number;

  private constructor(bytes: number) {
    this.#bytes = bytes;
  }

  static ofBytes(bytes: number): ByteSize {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw invalidArgument("next-nats.size", "INVALID_SIZE", `Invalid size of ${bytes} bytes: must be a positive integer`);
    }
    return new ByteSize(bytes);
  }

  static parse(value: string): ByteSize {
    const text = value.trim();
    const match = SIZE.exec(text);
    const factor = match ? UNITS[(match[2] || "b").toLowerCase()] : undefined;
    if (!match || factor === undefined) {
      throw invalidArgument(
        "next-nats.size",
        "INVALID_SIZE",
        `Invalid size "${value}": use bytes or a unit such as "128MiB" or "1GiB" (B, KB, KiB, MB, MiB, GB, GiB, TB, TiB)`,
      );
    }
    return ByteSize.ofBytes(Math.round(Number(match[1]) * factor));
  }

  get bytes(): number {
    return this.#bytes;
  }

  toBytes(): number {
    return this.#bytes;
  }

  equals(other: ByteSize): boolean {
    return this.#bytes === other.#bytes;
  }

  toString(): string {
    return `${this.#bytes}B`;
  }
}

export type ByteSizeInput = ByteSize | string | number;

export function byteSize(input: ByteSizeInput): ByteSize {
  if (input instanceof ByteSize) return input;
  return typeof input === "number" ? ByteSize.ofBytes(input) : ByteSize.parse(input);
}

export const SYNADIA_DEFAULT_STREAM_MAX_BYTES = 128 * 1_048_576;

import { invalidArgument } from "./errors.js";

const NANOS: Record<string, number> = {
  ns: 1,
  us: 1_000,
  "µs": 1_000,
  "μs": 1_000,
  ms: 1_000_000,
  s: 1_000_000_000,
  m: 60 * 1_000_000_000,
  h: 3_600 * 1_000_000_000,
  d: 86_400 * 1_000_000_000,
};

const SEGMENT = /(\d+(?:\.\d+)?|\.\d+)(ns|us|µs|μs|ms|s|m|h|d)/y;

export class Duration {
  readonly #nanos: number;

  private constructor(nanos: number) {
    this.#nanos = nanos;
  }

  static ofNanos(nanos: number): Duration {
    if (!Number.isSafeInteger(nanos) || nanos < 0) {
      throw invalidArgument("next-nats.duration", "INVALID_DURATION", `Invalid duration of ${nanos} nanoseconds`);
    }
    return new Duration(nanos);
  }

  static ofMillis(millis: number): Duration {
    if (!Number.isFinite(millis) || millis < 0) {
      throw invalidArgument("next-nats.duration", "INVALID_DURATION", `Invalid duration of ${millis} milliseconds`);
    }
    return Duration.ofNanos(Math.round(millis * 1_000_000));
  }

  static parse(value: string): Duration {
    const text = value.trim();
    const fail = () =>
      invalidArgument(
        "next-nats.duration",
        "INVALID_DURATION",
        `Invalid duration "${value}": use Go style units such as "90s", "1h30m" or "24h" (ns, us, ms, s, m, h, d)`,
      );
    if (text === "0") return new Duration(0);
    if (text.length === 0) throw fail();
    let total = 0;
    let index = 0;
    SEGMENT.lastIndex = 0;
    while (index < text.length) {
      SEGMENT.lastIndex = index;
      const match = SEGMENT.exec(text);
      if (!match) throw fail();
      total += Number(match[1]) * NANOS[match[2]!]!;
      index = SEGMENT.lastIndex;
    }
    return Duration.ofNanos(Math.round(total));
  }

  get nanos(): number {
    return this.#nanos;
  }

  get millis(): number {
    return this.#nanos / 1_000_000;
  }

  toNanos(): number {
    return this.#nanos;
  }

  toMillis(): number {
    return this.millis;
  }

  equals(other: Duration): boolean {
    return this.#nanos === other.#nanos;
  }

  toString(): string {
    return `${this.#nanos}ns`;
  }
}

export type DurationInput = Duration | string | number;

export function duration(input: DurationInput): Duration {
  if (input instanceof Duration) return input;
  return typeof input === "number" ? Duration.ofMillis(input) : Duration.parse(input);
}

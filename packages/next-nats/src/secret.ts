import { inspect } from "node:util";

const SECRET_SYNTAX = /^secret:(?:[a-z0-9-]*):(?:[a-z0-9-]*):(.+)$/s;
const REDACTED = "[REDACTED]";

export class Secret {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static of(value: string | Secret): Secret {
    return value instanceof Secret ? value : new Secret(value);
  }

  static parse(raw: string | Secret): Secret {
    if (raw instanceof Secret) return raw;
    const match = SECRET_SYNTAX.exec(raw);
    return new Secret(match ? match[1]! : raw);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}

export function secretFromEnv(value: string | undefined): Secret | undefined {
  return value === undefined || value === "" ? undefined : Secret.parse(value);
}

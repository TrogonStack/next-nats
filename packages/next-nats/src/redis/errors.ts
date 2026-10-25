export { UpstashError } from "../kv/store.js";

export class UrlError extends Error {
  constructor(url: string) {
    super(`Upstash Redis client was passed an invalid URL. You should pass a URL starting with https. Received: "${url}". `);
    this.name = "UrlError";
  }
}

export class UpstashJSONParseError extends Error {
  constructor(body: string, options?: { cause?: unknown }) {
    super(`Unable to parse response body: ${body.length > 200 ? `${body.slice(0, 200)}...` : body}`, options);
    this.name = "UpstashJSONParseError";
  }
}

export class UnsupportedCommandError extends Error {
  constructor(feature: string) {
    super(`${feature} is not supported by @trogonstack/next-nats/redis, see docs/references/redis.md`);
    this.name = "UnsupportedCommandError";
  }
}

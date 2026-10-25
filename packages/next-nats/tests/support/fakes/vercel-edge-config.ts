import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeValue = string | number | boolean | null | { [x: string]: FakeValue } | FakeValue[];

export type FakeOperation =
  | { operation: "create" | "update" | "upsert"; key: string; value: FakeValue }
  | { operation: "delete"; key: string };

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
}

const KEY_RULE = /^[A-Za-z0-9_-]{1,256}$/;

export class FakeVercelEdgeConfig {
  readonly readToken = "read-token";
  readonly apiToken = "api-token";
  readonly requests: RecordedRequest[] = [];
  private readonly configs = new Map<string, Map<string, FakeValue>>();
  private server?: Server;
  private origin = "";

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  create(id: string, items: Record<string, FakeValue> = {}): void {
    this.configs.set(id, new Map(Object.entries(items)));
  }

  connectionString(id: string, token = this.readToken): string {
    return `${this.origin}/${id}?token=${token}`;
  }

  restUrl(id: string): string {
    return `${this.origin}/v1/edge-config/${id}/items`;
  }

  snapshot(id: string): Record<string, FakeValue> {
    return Object.fromEntries(this.configs.get(id) ?? []);
  }

  digestOf(id: string): string {
    return digestOf(this.configs.get(id) ?? new Map());
  }

  async patch(id: string, items: unknown[]): Promise<{ status: number; body: any }> {
    const res = await fetch(this.restUrl(id), {
      method: "PATCH",
      headers: { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    return { status: res.status, body: await res.json() };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    this.requests.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, headers: req.headers });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "v1" && parts[1] === "edge-config" && parts[3] === "items" && req.method === "PATCH") {
      return this.handlePatch(parts[2]!, req, res);
    }
    return this.handleRead(parts, url, req, res);
  }

  private handleRead(parts: string[], url: URL, req: IncomingMessage, res: ServerResponse): void {
    const [id, kind, ...rest] = parts;
    const items = id ? this.configs.get(id) : undefined;
    if (req.headers.authorization !== `Bearer ${this.readToken}`) return json(res, 401, { error: { code: "forbidden" } });
    if (!items) return json(res, 404, { error: { code: "edge_config_not_found" } });
    // Assumption: the digest is an opaque content hash and the ETag is derived from it, so any write invalidates every cached response.
    const digest = digestOf(items);
    const base = { "x-edge-config-digest": digest, ETag: `"${digest}"` };
    if (req.method === "GET" && req.headers["if-none-match"] === base.ETag) {
      res.writeHead(304, base).end();
      return;
    }
    if (kind === "digest") return json(res, 200, digest, base);
    if (kind === "items") {
      // Assumption: the server omits requested keys that do not exist instead of failing.
      const keys = url.searchParams.getAll("key");
      const entries = [...items].filter(([k]) => keys.length === 0 || keys.includes(k));
      return json(res, 200, Object.fromEntries(entries), base);
    }
    if (kind === "item") {
      const key = decodeURIComponent(rest.join("/"));
      // Documented by the client source: a 404 carrying x-edge-config-digest means a missing item, without it a missing Edge Config.
      if (!items.has(key)) {
        res.writeHead(404, { "x-edge-config-digest": digest }).end();
        return;
      }
      if (req.method === "HEAD") {
        res.writeHead(200, base).end();
        return;
      }
      return json(res, 200, items.get(key), base);
    }
    return json(res, 404, { error: { code: "not_found" } });
  }

  private async handlePatch(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.apiToken}`) return json(res, 403, { error: { code: "forbidden" } });
    const items = this.configs.get(id);
    if (!items) return json(res, 404, { error: { code: "not_found" } });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { items: FakeOperation[] };
    // Documented: if one operation fails, the whole request fails. Assumption: failures are 400 with an error code, and delete of a missing key fails like update.
    const next = new Map(items);
    for (const op of body.items) {
      // Documented: keys are alphanumeric, underscore and hyphen only, up to 256 characters.
      if (!KEY_RULE.test(op.key)) return json(res, 400, { error: { code: "bad_request", message: `Invalid key "${op.key}"` } });
      const exists = next.has(op.key);
      if (op.operation === "create" && exists) return json(res, 400, { error: { code: "edge_config_item_exists", key: op.key } });
      if ((op.operation === "update" || op.operation === "delete") && !exists) {
        return json(res, 400, { error: { code: "edge_config_item_not_found", key: op.key } });
      }
      if (op.operation === "delete") next.delete(op.key);
      else next.set(op.key, op.value);
    }
    this.configs.set(id, next);
    return json(res, 200, { status: "ok" });
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

function digestOf(items: Map<string, FakeValue>): string {
  const sorted = [...items].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 32);
}

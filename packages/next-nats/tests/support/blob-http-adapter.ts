import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export type FetchHandler = (request: Request) => Promise<Response>;

export interface HttpApp {
  readonly origin: string;
  close(): Promise<void>;
}

function requestOf(incoming: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const controller = new AbortController();
  incoming.on("close", () => {
    if (!incoming.complete) controller.abort();
  });
  return new Request(new URL(incoming.url ?? "/", origin), {
    method,
    headers,
    signal: controller.signal,
    ...(hasBody && { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" }),
  } as RequestInit);
}

async function write(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!outgoing.write(chunk.value)) await new Promise((resolve) => outgoing.once("drain", resolve));
    }
  } finally {
    outgoing.end();
  }
}

export async function serveFetchHandler(handler: FetchHandler): Promise<HttpApp> {
  let origin = "";
  const server: Server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        await write(await handler(requestOf(incoming, origin)), outgoing);
      } catch (error) {
        outgoing.statusCode = 500;
        outgoing.end(error instanceof Error ? error.message : "error");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export interface CapturedCronCall {
  receivedAt: number;
  path: string;
  headers: IncomingHttpHeaders;
  forwardedStatus: number;
}

export interface CronCapture {
  readonly baseUrl: string;
  readonly calls: CapturedCronCall[];
  stop(): Promise<void>;
}

export async function startCronCapture(port: number, forwardTo: (path: string) => string): Promise<CronCapture> {
  const calls: CapturedCronCall[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (name === "host" || name === "connection" || value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    fetch(forwardTo(path), { method: request.method, headers, redirect: "manual" })
      .then(async (upstream) => {
        calls.push({ receivedAt: Date.now(), path, headers: request.headers, forwardedStatus: upstream.status });
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/plain" });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      })
      .catch(() => {
        calls.push({ receivedAt: Date.now(), path, headers: request.headers, forwardedStatus: 502 });
        response.writeHead(502).end();
      });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

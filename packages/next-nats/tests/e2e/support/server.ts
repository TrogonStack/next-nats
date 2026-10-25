import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { DEMO_ROOT, distDirOf, natsServers, type BuildVariant } from "./env.js";

export interface RunningServer {
  readonly origin: string;
  readonly port: number;
  readonly pid: number;
  logs(): string;
  stop(): Promise<void>;
}

export interface StartServerOptions {
  variant: BuildVariant;
  port: number;
  env?: Record<string, string>;
}

const NEXT_BIN = createRequire(`${DEMO_ROOT}/package.json`).resolve("next/dist/bin/next");

export const SHARED_ENV = {
  BLOB_SECRET: "e2e-blob-secret",
  NATS_QUEUE_SECRET: "e2e-queue-secret",
} as const;

export async function startServer({ variant, port, env = {} }: StartServerOptions): Promise<RunningServer> {
  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port)], {
    cwd: DEMO_ROOT,
    env: {
      ...process.env,
      ...SHARED_ENV,
      NODE_ENV: "production",
      NATS_SERVERS: natsServers(),
      NATS_WORKERS: "true",
      NEXT_DIST_DIR: distDirOf(variant),
      PORT: String(port),
      CLOCK_ORIGIN: origin,
      BLOB_BASE_URL: `${origin}/blob`,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const server: RunningServer = {
    origin,
    port,
    pid: child.pid ?? -1,
    logs: () => output,
    async stop() {
      const signal = (name: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, name);
        } catch {
          return;
        }
      };
      signal("SIGTERM");
      const killer = setTimeout(() => signal("SIGKILL"), 10_000);
      await exited;
      signal("SIGTERM");
      clearTimeout(killer);
    },
  };
  try {
    await waitUntil(async () => (await fetch(`${origin}/-/liveness`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined))?.status === 200, 60_000, `server on ${port} to start\n${output}`);
  } catch (error) {
    await server.stop();
    throw error;
  }
  return server;
}

export async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

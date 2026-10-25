import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { natsServers } from "./env.js";

const WORKER = fileURLToPath(new URL("./kv-worker.mjs", import.meta.url));

export interface WorkerReport {
  acknowledged: number;
  failed: number;
}

export interface KvWorkerOptions {
  bucket: string;
  source: string;
  target: string;
  operations: number;
}

export function runKvWorker({ bucket, source, target, operations }: KvWorkerOptions): Promise<WorkerReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=react-server", WORKER, source, target, String(operations)], {
      env: { ...process.env, NATS_SERVERS: natsServers(), NEXT_NATS_KV_BUCKET: bucket, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`kv worker exited ${code}\n${stderr}`));
      else resolve(JSON.parse(stdout) as WorkerReport);
    });
  });
}

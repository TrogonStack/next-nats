import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { BUILD_ROOT, DEMO_ROOT, REPOSITORY_ROOT, distDirOf, natsServers, type BuildVariant } from "./env.js";

const NEXT_ARGS: Record<BuildVariant, string[]> = {
  turbopack: ["build"],
  webpack: ["build", "--webpack"],
  vercel: ["build"],
};

export async function buildDemo(variant: BuildVariant): Promise<void> {
  await mkdir(`${REPOSITORY_ROOT}.trogonai/e2e`, { recursive: true });
  const log = createWriteStream(`${REPOSITORY_ROOT}.trogonai/e2e/build-${variant}.log`);
  const env: NodeJS.ProcessEnv = { ...process.env, NATS_SERVERS: natsServers(), NEXT_DIST_DIR: distDirOf(variant) };
  delete env.VERCEL;
  if (variant === "vercel") env.VERCEL = "1";
  const child = spawn("pnpm", ["exec", "next", ...NEXT_ARGS[variant]], { cwd: DEMO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  log.end();
  if (code !== 0) throw new Error(`next build (${variant}) exited with ${code}; see ${BUILD_ROOT} log .trogonai/e2e/build-${variant}.log`);
}

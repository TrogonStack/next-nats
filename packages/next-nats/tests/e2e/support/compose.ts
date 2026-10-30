import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { composeProject, natsServers, REPOSITORY_ROOT } from "./env.js";
import { waitUntil } from "./server.js";

const run = promisify(execFile);
const COMPOSE_FILE = `${REPOSITORY_ROOT}devops/docker/compose/compose.yaml`;

export const compose = (...args: string[]) =>
  run("docker", ["compose", "-p", composeProject(), ...args], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, COMPOSE_FILE: process.env.COMPOSE_FILE ?? COMPOSE_FILE },
  });

function acceptsConnections(): Promise<boolean> {
  const { hostname, port } = new URL(natsServers().split(",")[0]!);
  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname, port: Number(port) || 4222 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

export async function restartNats(): Promise<void> {
  await compose("restart", "nats");
  await waitUntil(acceptsConnections, 60_000, "NATS to accept connections after the restart", 250);
}

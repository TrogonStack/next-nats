import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { composeProject, REPOSITORY_ROOT } from "./env.js";
import { waitUntil } from "./server.js";

const run = promisify(execFile);
const COMPOSE_FILE = `${REPOSITORY_ROOT}devops/docker/compose/compose.yaml`;

export const LIMITED_USER = "capped";
export const LIMITED_PASSWORD = "capped";
export const LIMITED_MAX_STREAMS = 5;
export const LIMITED_STREAM_MAX_BYTES = "128MiB";

export const limitedUrl = () => `nats://nats-limited.${composeProject()}.orb.local:4222`;

const compose = (...args: string[]) => run("docker", ["compose", "-p", composeProject(), "-f", COMPOSE_FILE, "--profile", "limits", ...args], { cwd: REPOSITORY_ROOT });

export const limitedEnv = (): Record<string, string> => ({
  NATS_URL: limitedUrl(),
  NATS_USER: LIMITED_USER,
  NATS_PASSWORD: LIMITED_PASSWORD,
  NATS_STREAM_MAX_BYTES: LIMITED_STREAM_MAX_BYTES,
});

export interface LimitedNats {
  streams(): Promise<string[]>;
  consumers(): Promise<number>;
  fill(count: number): Promise<void>;
  reset(keep?: readonly string[]): Promise<void>;
  stop(): Promise<void>;
}

export async function startLimitedNats(): Promise<LimitedNats> {
  await compose("up", "-d", "--wait", "nats-limited");
  let nc: NatsConnection | undefined;
  let jsm: JetStreamManager | undefined;
  await waitUntil(
    async () => {
      try {
        nc = await connect({ servers: limitedUrl(), user: LIMITED_USER, pass: LIMITED_PASSWORD });
        jsm = await jetstreamManager(nc);
        return true;
      } catch {
        await nc?.close().catch(() => undefined);
        return false;
      }
    },
    30_000,
    "the capped NATS account to accept connections",
    250,
  );
  const manager = jsm!;
  const streams = async () => {
    const names: string[] = [];
    for await (const info of manager.streams.list()) names.push(info.config.name);
    return names.sort();
  };
  return {
    streams,
    async consumers() {
      return (await manager.getAccountInfo()).consumers;
    },
    async fill(count) {
      for (let index = 0; index < count; index++) {
        await manager.streams.add({ name: `FILLER${index}`, subjects: [`filler.${index}.>`], max_bytes: 1024 * 1024 });
      }
    },
    async reset(keep = []) {
      for (const name of await streams()) if (!keep.includes(name)) await manager.streams.delete(name);
    },
    async stop() {
      await nc?.close().catch(() => undefined);
      await compose("rm", "-sfv", "nats-limited");
    },
  };
}

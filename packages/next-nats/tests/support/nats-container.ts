import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface NatsContainer {
  readonly name: string;
  port(containerPort: number): number;
  stop(): void;
}

export function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const logsOf = (name: string) => {
  const r = spawnSync("docker", ["logs", name], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export async function startNatsContainer(conf: string, containerPorts: number[]): Promise<NatsContainer> {
  const name = `nn-gcore-test-${randomBytes(4).toString("hex")}`;
  const publish = containerPorts.flatMap((p) => ["-p", `127.0.0.1::${p}`]);
  docker(
    "run", "-d", "--name", name, ...publish, "-e", `NATS_CONF=${conf}`, "--entrypoint", "sh", "nats:2.12-alpine",
    "-c", 'printf "%s" "$NATS_CONF" > /tmp/n.conf && exec nats-server -c /tmp/n.conf',
  );
  const ports = new Map<number, number>();
  const stop = () => {
    try {
      docker("rm", "-f", name);
    } catch {
      return;
    }
  };
  try {
    const deadline = Date.now() + 20_000;
    for (const p of containerPorts) {
      for (;;) {
        try {
          ports.set(p, Number(docker("port", name, String(p)).split("\n")[0]!.split(":").pop()));
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
    while (!logsOf(name).includes("Server is ready")) {
      if (Date.now() > deadline) throw new Error(`nats container ${name} did not become ready`);
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (error) {
    const logs = logsOf(name);
    stop();
    throw new Error(`${(error as Error).message}\n${logs}`);
  }
  return { name, port: (p) => ports.get(p)!, stop };
}

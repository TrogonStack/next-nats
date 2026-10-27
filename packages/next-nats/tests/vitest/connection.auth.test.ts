import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, onNatsConnectError, onNatsDisconnect, onNatsReconnect, type NatsConnectErrorEvent } from "../../src/connection.js";
import { CredentialsExpiredError } from "../../src/jwt.js";
import { setLogger, silentLogger, type LogContext, type Logger } from "../../src/logger.js";
import { createTestOperator } from "../support/jwt.js";
import { dockerAvailable, startNatsContainer, type NatsContainer } from "../support/nats-container.js";

const available = dockerAvailable();
const op = createTestOperator();
const at = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

let container: NatsContainer;
let dir: string;
let servers: string;

beforeAll(async () => {
  if (!available) return;
  container = await startNatsContainer(op.conf, [4222, 8222]);
  servers = `nats://127.0.0.1:${container.port(4222)}`;
  dir = mkdtempSync(join(tmpdir(), "nn-auth-"));
});

afterAll(() => {
  container?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

let logs: { level: string; message: string; context?: LogContext }[] = [];
const capture: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warning: (message, context) => void logs.push({ level: "warning", message, context }),
  error: (message, context) => void logs.push({ level: "error", message, context }),
};

afterEach(async () => {
  setLogger(silentLogger);
  await closeNats();
});

async function users(): Promise<string[]> {
  const body = (await fetch(`http://127.0.0.1:${container.port(8222)}/connz?auth=true`).then((r) => r.json())) as {
    connections: { authorized_user?: string; name?: string }[];
  };
  return body.connections.filter((c) => c.name === "auth-test").map((c) => c.authorized_user!);
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const config = { name: "auth-test", maxReconnectAttempts: -1, reconnectTimeWait: 200 };

describe.skipIf(!available)("jwt based auth against an operator server", () => {
  it("connects with inline creds", async () => {
    const user = op.user("inline");
    await connectNats({ ...config, servers, auth: { kind: "creds", creds: user.creds } });
    expect(await users()).toEqual([user.publicKey]);
  });

  it("connects with a user jwt and nkey seed", async () => {
    const user = op.user("jwt");
    await connectNats({ ...config, servers, auth: { kind: "jwt", userJwt: user.jwt, seed: user.seed } });
    expect(await users()).toEqual([user.publicKey]);
  });

  it("connects with a bearer jwt alone", async () => {
    const user = op.user("bearer", undefined, true);
    await connectNats({ ...config, servers, auth: { kind: "bearer", userJwt: user.jwt } });
    expect(await users()).toEqual([user.publicKey]);
  });

  it("re-reads the creds file on every reconnect", async () => {
    const first = op.user("file-1");
    const second = op.user("file-2");
    const path = join(dir, "rotate.creds");
    writeFileSync(path, first.creds);
    const reconnects: number[] = [];
    const disconnects: string[] = [];
    const offs = [onNatsReconnect((e) => reconnects.push(e.downtimeMs)), onNatsDisconnect((e) => disconnects.push(e.server))];
    const { nc } = await connectNats({ ...config, servers, auth: { kind: "credsFile", path } });
    expect(await users()).toEqual([first.publicKey]);

    writeFileSync(path, second.creds);
    await nc.reconnect();
    await waitFor(async () => (await users())[0] === second.publicKey);
    expect(await users()).toEqual([second.publicKey]);

    writeFileSync(path, first.creds);
    await nc.reconnect();
    await waitFor(async () => (await users())[0] === first.publicKey);
    await waitFor(async () => reconnects.length === 2 && disconnects.length === 2);
    expect(reconnects).toHaveLength(2);
    expect(disconnects).toHaveLength(2);
    for (const off of offs) off();
  });

  it("fails fast with a typed error on an expired jwt and reports it as an auth error", async () => {
    setLogger(capture);
    logs = [];
    const user = op.user("expired", at(-60));
    const events: NatsConnectErrorEvent[] = [];
    const off = onNatsConnectError((e) => events.push(e));
    await expect(connectNats({ ...config, servers, auth: { kind: "creds", creds: user.creds } })).rejects.toBeInstanceOf(CredentialsExpiredError);
    off();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("auth");
    const entry = logs.find((l) => l.message.startsWith("AUTH ERROR"));
    expect(entry?.level).toBe("error");
    expect(JSON.stringify(logs)).not.toContain(user.seed);
    expect(JSON.stringify(logs)).not.toContain(user.jwt);
  });

  it.each(["jwt", "bearer"] as const)("rejects an expired %s", async (kind) => {
    const user = op.user("expired-kind", at(-60));
    const auth = kind === "jwt" ? { kind, userJwt: user.jwt, seed: user.seed } : { kind, userJwt: user.jwt };
    await expect(connectNats({ ...config, servers, auth })).rejects.toBeInstanceOf(CredentialsExpiredError);
  });

  it("rejects an expired creds file", async () => {
    const path = join(dir, "expired.creds");
    writeFileSync(path, op.user("expired-file", at(-60)).creds);
    await expect(connectNats({ ...config, servers, auth: { kind: "credsFile", path } })).rejects.toBeInstanceOf(CredentialsExpiredError);
  });

  it("warns when the jwt expires within 24 hours but still connects", async () => {
    setLogger(capture);
    logs = [];
    const user = op.user("soon", at(3600));
    await connectNats({ ...config, servers, auth: { kind: "creds", creds: user.creds } });
    expect(logs.some((l) => l.level === "warning" && /expire in/.test(l.message))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(user.seed);
  });

  it("does not warn when the jwt has more than 24 hours left", async () => {
    setLogger(capture);
    logs = [];
    await connectNats({ ...config, servers, auth: { kind: "creds", creds: op.user("later", at(3 * 86400)).creds } });
    expect(logs).toEqual([]);
  });

  it("logs a server rejection with the AUTH ERROR prefix", async () => {
    setLogger(capture);
    logs = [];
    const events: NatsConnectErrorEvent[] = [];
    const off = onNatsConnectError((e) => events.push(e));
    const stranger = createTestOperator().user("stranger");
    await expect(connectNats({ ...config, servers, auth: { kind: "creds", creds: stranger.creds } })).rejects.toBeDefined();
    off();
    expect(events.map((e) => e.kind)).toEqual(["auth"]);
    expect(logs.some((l) => l.message.startsWith("AUTH ERROR"))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(stranger.seed);
  });
});

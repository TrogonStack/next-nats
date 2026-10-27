import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNats, connectNats, getNats, onNatsShutdown } from "../../src/connection.js";
import { collectDiagnostics } from "../../src/diagnostics.js";
import { defineAgent, getAgents, getAgentStatuses, stopAllAgents, type ActiveAgent } from "../../src/agents/index.js";

const run = Math.random().toString(36).slice(2, 8);
const owner = `own${run}`;

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function collect(stream: AsyncIterable<{ type: string; [key: string]: any }>, onQuery?: (q: any) => Promise<void>) {
  const text: string[] = [];
  for await (const message of stream) {
    if (message.type === "response") text.push(message.text);
    if (message.type === "query") await onQuery?.(message);
  }
  return text;
}

async function discoverOne(name: string) {
  const agents = await getAgents();
  let found: Awaited<ReturnType<typeof agents.discover>> = [];
  await waitFor(async () => {
    found = await agents.discover({ timeoutMs: 1_000, filter: { owner, name } });
    return found.length > 0;
  });
  return found[0]!;
}

let echo: ActiveAgent;

beforeAll(async () => {
  await connectNats({ servers: process.env.NATS_URL, workers: true, name: "next-nats-agents-test" });
  echo = defineAgent({
    agent: "echo",
    owner,
    name: "main",
    description: "echo agent",
    version: "1.2.3",
    heartbeatIntervalS: 1,
    maxPayload: "64MB",
    extraMetadata: { team: "qa", agent: "spoofed", owner: "spoofed" },
    heartbeatExtras: () => ({ handled: 7 }),
    onPrompt: async (envelope, response) => {
      await response.send({ type: "status", status: "thinking" });
      await response.send(`echo: ${envelope.prompt}`);
      await response.send("done");
    },
  });
  await waitFor(() => echo.status() === "running");
});

afterAll(async () => {
  await stopAllAgents();
  await closeNats();
});

describe("agents", () => {
  it("registers once per identity", () => {
    const again = defineAgent({ agent: "echo", owner, name: "main", onPrompt: async () => {} });
    expect(again).toBe(echo);
    expect(getAgentStatuses().filter((s) => s.owner === owner)).toHaveLength(1);
  });

  it("is discoverable with its identity, metadata and clamped payload", async () => {
    const info = await discoverOne("main");
    expect(info.agent).toBe("echo");
    expect(info.owner).toBe(owner);
    expect(info.version).toBe("1.2.3");
    expect(info.description).toBe("echo agent");
    expect(info.metadata.team).toBe("qa");
    expect(info.metadata.agent).toBe("echo");
    expect(info.metadata.owner).toBe(owner);
    const { nc } = await getNats();
    expect(info.promptEndpoint.maxPayloadBytes).toBe(nc.info!.max_payload);
  });

  it("streams a prompt response", async () => {
    const info = await discoverOne("main");
    const stream = await info.prompt("hello");
    expect(await collect(stream)).toEqual(["echo: hello", "done"]);
  });

  it("reports status with heartbeat extras", async () => {
    const info = await discoverOne("main");
    const status = await info.status();
    expect(status.agent).toBe("echo");
    expect(status.extras.handled).toBe(7);
  });

  it("answers a mid-stream ask", async () => {
    const asker = defineAgent({
      agent: "asker",
      owner,
      name: "answered",
      onPrompt: async (_envelope, response) => {
        const answer = await response.ask("which color?", { timeoutMs: 5_000 });
        await response.send(`color=${answer.prompt}`);
      },
    });
    await waitFor(() => asker.status() === "running");
    const info = await discoverOne("answered");
    const stream = await info.prompt("go");
    const text = await collect(stream, (q) => q.reply("blue"));
    expect(text).toEqual(["color=blue"]);
  });

  it("times out a mid-stream ask", async () => {
    const asker = defineAgent({
      agent: "asker",
      owner,
      name: "timedout",
      onPrompt: async (_envelope, response) => {
        try {
          await response.ask("anyone?", { timeoutMs: 300 });
          await response.send("answered");
        } catch {
          await response.send("timed-out");
        }
      },
    });
    await waitFor(() => asker.status() === "running");
    const info = await discoverOne("timedout");
    const stream = await info.prompt("go");
    expect(await collect(stream)).toEqual(["timed-out"]);
  });

  it("caches the caller client", async () => {
    expect(await getAgents()).toBe(await getAgents());
  });

  it("contributes a diagnostics section only while agents exist", async () => {
    const during = (await collectDiagnostics()).agents as { agents: Array<{ owner: string; name: string; status: string }> };
    expect(during.agents.find((a) => a.owner === owner && a.name === "main")?.status).toBe("running");

    await stopAllAgents();
    expect("agents" in (await collectDiagnostics())).toBe(false);
    expect(getAgentStatuses()).toEqual([]);
  });

  it("stops idempotently and disappears from discovery", async () => {
    const temp = defineAgent({ agent: "temp", owner, name: "gone", onPrompt: async () => {} });
    await waitFor(() => temp.status() === "running");
    await discoverOne("gone");
    await Promise.all([temp.stop(), temp.stop()]);
    await temp.stop();
    expect(temp.status()).toBe("stopped");
    const agents = await getAgents();
    expect(await agents.discover({ timeoutMs: 1_000, filter: { owner, name: "gone" } })).toHaveLength(0);
  });

  it("surfaces a failing start as error status", async () => {
    const failing = defineAgent({
      agent: "bad",
      owner,
      name: "conflict",
      extraEndpoints: [{ name: "prompt", subject: "x.y", handler: () => {} }],
      onPrompt: async () => {},
    });
    await waitFor(() => failing.status() === "error");
    expect(getAgentStatuses().find((s) => s.name === "conflict")?.error).toBeDefined();
    await failing.stop();
  });

  it("stops agents before consumers and before the drain", async () => {
    const order: string[] = [];
    const ordered = defineAgent({ agent: "order", owner, name: "last", onPrompt: async () => {} });
    await waitFor(() => ordered.status() === "running");
    const { nc } = await getNats();
    const off = [
      onNatsShutdown(() => void order.push(`consumers:${ordered.status()}:${nc.isClosed()}`), { stage: "consumers" }),
      onNatsShutdown(() => void order.push(`default:${ordered.status()}:${nc.isClosed()}`)),
    ];
    await closeNats();
    off.forEach((fn) => fn());
    expect(order).toEqual(["consumers:stopped:false", "default:stopped:false"]);
    expect(nc.isClosed()).toBe(true);
  });
});

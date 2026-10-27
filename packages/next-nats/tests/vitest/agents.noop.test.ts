import { describe, expect, it } from "vitest";
import { configureNats } from "../../src/connection.js";
import { defineAgent, getAgentStatuses } from "../../src/agents/index.js";

describe("defineAgent without workers", () => {
  it("is a logged no-op that never connects", async () => {
    configureNats({ servers: "nats://127.0.0.1:1", workers: false });
    const agent = defineAgent({ agent: "noop", owner: "demo", name: "main", onPrompt: async () => {} });
    expect(agent.identity.promptSubject).toBe("agents.prompt.noop.demo.main");
    expect(agent.status()).toBe("stopped");
    expect(getAgentStatuses()).toEqual([]);
    await agent.stop();
    await agent.stop();
  });
});

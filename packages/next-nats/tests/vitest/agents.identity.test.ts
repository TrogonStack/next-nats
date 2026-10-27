import { describe, expect, it } from "vitest";
import { agentIdentity, agentInstanceName, agentName, agentOwner, agentSubjectToken } from "../../src/agents/identity.js";

describe("agent identity", () => {
  it("accepts protocol-valid tokens", () => {
    expect(agentName("claude-code")).toBe("claude-code");
    expect(agentOwner("Acme_1")).toBe("Acme_1");
    expect(agentInstanceName("main")).toBe("main");
  });

  it.each(["", "a.b", "a b", "a*", "a>", "$SYS", "a\0b", "a\tb"])("rejects %j", (value) => {
    expect(() => agentName(value)).toThrow(/Invalid agent name/);
    expect(() => agentOwner(value)).toThrow(/Invalid agent owner/);
    expect(() => agentInstanceName(value)).toThrow(/Invalid agent instance name/);
    expect(() => agentSubjectToken(value)).toThrow(/Invalid agent subject token/);
  });

  it("derives the prompt subject, defaulting the subject token to the agent", () => {
    expect(agentIdentity({ agent: "echo", owner: "demo", name: "main" }).promptSubject).toBe("agents.prompt.echo.demo.main");
    expect(agentIdentity({ agent: "claude-code", owner: "demo", name: "main", subjectToken: "cc" }).promptSubject).toBe(
      "agents.prompt.cc.demo.main",
    );
  });

  it("validates the subject token override", () => {
    expect(() => agentIdentity({ agent: "echo", owner: "demo", name: "main", subjectToken: "a.b" })).toThrow(/subject token/);
  });
});

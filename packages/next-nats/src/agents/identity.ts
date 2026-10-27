import { invalidArgument } from "../errors.js";
import type { Brand } from "../values.js";

export type AgentName = Brand<string, "AgentName">;
export type AgentOwner = Brand<string, "AgentOwner">;
export type AgentInstanceName = Brand<string, "AgentInstanceName">;
export type AgentSubjectToken = Brand<string, "AgentSubjectToken">;

const FORBIDDEN = /[.*>\s\0]/;

function token<B extends string>(role: string, value: string): Brand<string, B> {
  const reason =
    value.length === 0
      ? "must not be empty"
      : value.startsWith("$")
        ? `must not begin with "$"`
        : FORBIDDEN.test(value)
          ? `must not contain whitespace, ".", "*", ">" or NUL`
          : undefined;
  if (reason) throw invalidArgument("next-nats.agents", "INVALID_AGENT_TOKEN", `Invalid agent ${role} "${value}": ${reason}`);
  return value as Brand<string, B>;
}

export const agentName = (value: string): AgentName => token<"AgentName">("name", value);
export const agentOwner = (value: string): AgentOwner => token<"AgentOwner">("owner", value);
export const agentInstanceName = (value: string): AgentInstanceName => token<"AgentInstanceName">("instance name", value);
export const agentSubjectToken = (value: string): AgentSubjectToken => token<"AgentSubjectToken">("subject token", value);

export interface AgentIdentity {
  readonly agent: AgentName;
  readonly owner: AgentOwner;
  readonly name: AgentInstanceName;
  readonly subjectToken: AgentSubjectToken;
  readonly promptSubject: string;
}

export function agentIdentity(input: { agent: string; owner: string; name: string; subjectToken?: string }): AgentIdentity {
  const agent = agentName(input.agent);
  const owner = agentOwner(input.owner);
  const name = agentInstanceName(input.name);
  const subjectToken = input.subjectToken === undefined ? (agent as string as AgentSubjectToken) : agentSubjectToken(input.subjectToken);
  return { agent, owner, name, subjectToken, promptSubject: `agents.prompt.${subjectToken}.${owner}.${name}` };
}

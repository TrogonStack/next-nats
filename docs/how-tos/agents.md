# Host and call agents

Serve an AI agent over NATS and stream its answer to the browser.

## Host from instrumentation.ts

```ts
import { registerNats } from "@trogonstack/next-nats/instrumentation";

export async function register() {
  await registerNats({
    config: { workers: true },
    setup: () => import("./agents"),
  });
}
```

```ts
import { defineAgent } from "@trogonstack/next-nats/agents";

export const support = defineAgent({
  agent: "support",
  owner: "acme",
  name: "main",
  description: "Answers support questions",
  onPrompt: async (envelope, response) => {
    await response.send({ type: "status", status: "thinking" });
    const tone = await response.ask("Formal or casual?", { timeoutMs: 30_000 });
    await response.send(`(${tone.prompt}) You asked: ${envelope.prompt}`);
  },
});
```

Agents stop before consumers and before the connection drains.

## Call from a route handler with SSE

```ts
import { getAgents } from "@trogonstack/next-nats/agents";
import { createSseResponse } from "@trogonstack/next-nats/realtime";

export async function POST(request: Request) {
  const { prompt } = await request.json();
  const agents = await getAgents();
  const [agent] = await agents.discover({ filter: { agent: "support", owner: "acme" } });
  if (!agent) return new Response("agent offline", { status: 503 });
  const stream = await agent.prompt(prompt, { signal: request.signal });

  return createSseResponse(request, {}, (sink) => {
    void (async () => {
      try {
        for await (const message of stream) {
          if (message.type === "response") await sink.send({ event: "response", data: message.text });
          else if (message.type === "status") await sink.send({ event: "status", data: message.status });
          else await message.reply("casual");
        }
        sink.close();
      } catch (error) {
        sink.fail(error);
      }
    })();
    return () => stream.cancel();
  });
}
```

Answer `query` messages from your own logic, or forward them to the browser and reply later with `message.reply(answer)`.

See the [agents reference](../references/agents.md).

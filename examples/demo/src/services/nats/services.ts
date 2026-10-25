import { defineService, endpoint, EndpointError } from "@trogonstack/next-nats/services";

interface Operands {
  a: number;
  b: number;
}

function parseOperands(raw: unknown): Operands {
  const value = raw as Partial<Operands> | null;
  if (typeof value?.a !== "number" || typeof value.b !== "number" || !Number.isFinite(value.a + value.b)) {
    throw new EndpointError(400, "a and b must be finite numbers", { reason: "NOT_FINITE" });
  }
  return { a: value.a, b: value.b };
}

export const calculator = defineService({
  name: "calculator",
  version: "1.0.0",
  description: "Arithmetic over NATS request/reply",
  instances: 3,
  endpoints: {
    add: endpoint({
      input: parseOperands,
      handler: ({ a, b }) => ({ result: a + b }),
    }),
    divide: endpoint({
      input: parseOperands,
      handler: ({ a, b }) => {
        if (b === 0) throw new EndpointError(422, "Division by zero");
        return { result: a / b };
      },
    }),
  },
});

export const probe = defineService({
  name: "probe",
  version: "1.0.0",
  description: "Broadcast endpoint answered by every instance",
  queue: "",
  instances: 3,
  endpoints: {
    whoami: endpoint({
      handler: (_: void, ctx) => ({ instance: ctx.instance, pid: process.pid, at: new Date().toISOString() }),
    }),
  },
});

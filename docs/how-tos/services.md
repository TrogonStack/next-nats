# Expose and call services

Build request/reply services on NATS micro.

## Define

```ts
import { defineService, endpoint, EndpointError } from "@trogonstack/next-nats/services";

export const calculator = defineService({
  name: "calculator",
  version: "1.0.0",
  instances: 3,
  endpoints: {
    divide: endpoint({
      input: parseOperands,
      handler: ({ a, b }) => {
        if (b === 0) throw new EndpointError(422, "Division by zero");
        return { result: a / b };
      },
    }),
  },
});
```

`input` and `output` accept a function or any Standard Schema validator. Services start when workers are enabled.

## Call

```ts
import { serviceClient } from "@trogonstack/next-nats/services";

const calc = serviceClient(calculator);
const { result } = await calc.divide({ a: 6, b: 3 });
```

Pass the service name as a string to get an untyped client.

## Ask every instance

Give the service an empty `queue` so every instance answers, then gather:

```ts
const answers = await probeClient.whoami.gather(undefined, { maxWait: 500 });
```

Each answer is `{ ok: true, value }` or `{ ok: false, error }`.

## Discover what is running

```ts
import { discover } from "@trogonstack/next-nats/services";

const { ping, info, stats } = await discover({ name: "calculator" });
```

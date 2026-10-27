# Services

Exports of `@trogonstack/next-nats/services`, built on NATS micro.

## Defining

`defineService(config)` returns a `ServiceDefinition` with `name`, `version`, `endpoints`, `running`, `subjectOf(endpoint)`, `start()` and `stop()`. Services start automatically when workers are enabled. `stopAllServices()` stops every definition.

| Config field | Meaning |
| --- | --- |
| `name`, `version`, `description`, `metadata` | Service identity |
| `queue` | Queue group. An empty string makes every instance answer |
| `instances` | Instances started in this process. Each one holds about ten subscriptions on the shared connection, plus one per endpoint, so keep it small where the server caps subscriptions per connection |
| `endpoints` | Map of endpoint name to `endpoint({ ... })` |
| `onError` | Receives handler failures |

`endpoint({ subject?, queue?, metadata?, input?, output?, handler })` handler receives the parsed input and an `EndpointContext` with `service`, `endpoint`, `instance`, `subject` and `headers`. `endpointSubject(service, endpoint, override?)` gives the subject.

`SERVICE_INSTANCE_HEADER` is the reply header naming the answering instance.

## Calling

`serviceClient(serviceOrName, options?)` returns one function per endpoint. Each takes `(input, { timeout, headers, traceparent })` and has `.gather(input, { maxWait, maxMessages, ... })` resolving a list of `{ ok, instance, value | error }`, and `.subject`. Options accept `subjects` overrides.

## Discovery

`discover({ name?, id?, timeout? })` resolves `{ ping, info, stats }` from every matching instance.

## Validation

`input` and `output` are a function, an object with `parse`, or a Standard Schema. `runParser` applies one. `ValidationError` carries the issues.

## Errors

`EndpointError(code, message)` thrown in a handler becomes an error reply with that code. `ServiceCallError` is thrown to callers, with the failure in `ServiceCallFailure`.

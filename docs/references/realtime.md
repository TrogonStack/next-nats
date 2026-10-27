# Realtime

## Server, @trogonstack/next-nats/realtime

| Export | Description |
| --- | --- |
| `sseFromSubject(request, subject, options?)` | SSE response backed by a core subscription |
| `sseFromStream(request, options)` | SSE response backed by an ordered JetStream consumer |
| `consumeEphemeral(options)` | Request-scoped ordered consumer that always cleans up |
| `createSseResponse(request, options, setup)` | Build a custom SSE response with a sink and cleanup |
| `formatSseEvent`, `lastEventId`, `lastEventSequence` | SSE framing and resume helpers |

Shared options: `event` (SSE event name), `filter(message)` and `transform(message)` returning an SSE event or `null` to skip, plus the SSE options `heartbeat` (15 seconds), `retry`, `maxBuffered` (1000 events) and `headers`.

Stream options add `stream` (required), `filterSubjects`, `deliver` and `inactiveThreshold`. A reconnecting client's `Last-Event-ID` resumes after that stream sequence.

## consumeEphemeral

`consumeEphemeral({ stream, filterSubjects?, signal?, timeoutMs?, deliver?, inactiveThreshold?, handler, onError? })` creates an ordered consumer for the life of one request and resolves with `"aborted"`, `"timeout"` or `"ended"`. `deliver` takes the same values as `sseFromStream` and defaults to `"new"`. `handler` receives each `JsMsg`. A handler that throws is reported to `onError` and the next message is still delivered; an `onError` that throws is ignored. The consumer is deleted on every exit path, including when the stream is missing or the signal was already aborted (no consumer is created then).

A `RealtimeMessage` carries `subject`, decoded `data`, raw `payload`, `headers`, and for streams `seq` and `timestamp`.

## Client, @trogonstack/next-nats/realtime/client

`useNatsEvents({ url, events?, limit?, enabled?, withCredentials?, minDelay?, maxDelay?, onParse?, onEvent? })` returns `{ events, status, lastEventId, clear }`. `status` is `connecting`, `open` or `closed`. Passing `url: null` disconnects. Reconnects back off between `minDelay` and `maxDelay` and send the last event id.

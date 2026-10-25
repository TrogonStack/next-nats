# Realtime

## Server, next-nats/realtime

| Export | Description |
| --- | --- |
| `sseFromSubject(request, subject, options?)` | SSE response backed by a core subscription |
| `sseFromStream(request, options)` | SSE response backed by an ordered JetStream consumer |
| `createSseResponse(request, options, setup)` | Build a custom SSE response with a sink and cleanup |
| `formatSseEvent`, `lastEventId`, `lastEventSequence` | SSE framing and resume helpers |

Shared options: `event` (SSE event name), `filter(message)` and `transform(message)` returning an SSE event or `null` to skip, plus the SSE options `heartbeat` (15 seconds), `retry`, `maxBuffered` (1000 events) and `headers`.

Stream options add `stream` (required), `filterSubjects`, `deliver` and `inactiveThreshold`. A reconnecting client's `Last-Event-ID` resumes after that stream sequence.

A `RealtimeMessage` carries `subject`, decoded `data`, raw `payload`, `headers`, and for streams `seq` and `timestamp`.

## Client, next-nats/realtime/client

`useNatsEvents({ url, events?, limit?, enabled?, withCredentials?, minDelay?, maxDelay?, onParse?, onEvent? })` returns `{ events, status, lastEventId, clear }`. `status` is `connecting`, `open` or `closed`. Passing `url: null` disconnects. Reconnects back off between `minDelay` and `maxDelay` and send the last event id.

# Why NATS for each primitive

One server replaces several managed services, and each primitive maps onto a feature NATS already has.

- **KV.** A KV bucket is a JetStream stream keyed by subject, with revisions. Compare-and-set on the revision gives atomic read-modify-write for one key, which covers counters, conditional sets and hash fields. Per-message TTL removes expired keys from storage.
- **Blob.** The Object Store chunks large values across a stream, so bodies larger than a message are fine. Signed tokens let the browser upload and download through a route handler without NATS credentials.
- **Queue.** A stream with durable pull consumers gives consumer groups, acknowledgements, delayed redelivery, delivery counts and message deduplication by id. Those are the semantics a queue needs.
- **Edge Config.** Reads must be cheap and writes rare. A KV watcher keeps an in-process mirror current, so reads are memory lookups and a write reaches every replica as a watch event.
- **Cache.** Cache entries need shared storage and cheap invalidation. KV holds entries and tag timestamps, watches carry invalidations, and the Object Store absorbs large bodies. See [cache coherency](./cache-coherency.md).
- **Rate limiting.** Window counters are small records updated with compare-and-set, so replicas agree without a coordinator.
- **Realtime.** Subjects are already a publish/subscribe fabric. SSE adapts them to browsers, and an ordered consumer adds replay from a sequence for streams.
- **Services.** NATS micro adds naming, versioning, discovery and stats to request/reply. Queue groups spread load across instances and an empty queue group lets every instance answer for scatter-gather.
- **Cron.** A stream plus message deduplication turns many replicas ticking independently into one delivered tick. See [cron deduplication](./cron-deduplication.md).

Using one system also means one connection, one auth model, one place to monitor and one set of failure modes to understand.

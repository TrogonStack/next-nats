# Cache coherency

Replicas keep a small in-memory cache in front of NATS. The problem is keeping those copies from serving stale data after another replica changes it.

## Entries

An entry is stored in a KV bucket under the hash of its cache key, behind a prefix for its handler. Each process holds a byte-bounded LRU of recent entries and runs a watcher on that prefix in headers-only mode. When any replica writes or deletes a key, every watcher sees the new revision. A process evicts its copy if the copy is older than the announced revision, and records the revision so a slow read cannot reinstall an older body afterwards.

Bodies too large for a NATS message are written to the Object Store, and the KV entry holds a pointer. The previous object is removed after the new entry is written.

## Tags

Tag state lives under its own key prefix in the same bucket as the entries, as stale and expired timestamps per tag. Each process watches that prefix, keeps the records in memory and mirrors them into Next.js's tag manifest. Next.js then decides freshness with its usual rules. Updating a tag is a compare-and-set loop, so two replicas updating the same tag do not overwrite each other.

An invalidation on one replica therefore reaches the others as a watch event, within milliseconds when the network is healthy.

## Reconnects and gaps

If the watcher fails or the connection reconnects, the process clears its front cache and starts watching again, so a missed event cannot leave stale data behind. A gap costs extra reads, not wrong answers.

## Two handlers

`'use cache'` and ISR with the fetch cache are separate Next.js interfaces. next-nats installs a handler for each. They share the same connection, bucket and tag store, with separate key prefixes for their entries.

## One bucket

The handlers and the tags share one KV bucket, so serving a page costs one JetStream stream instead of three, which matters on accounts that cap the number of streams. A bucket has a single `max_age`, so it is set to the entry lifetime plus a day, which is what tags always needed. Entries record their own expiry and are ignored once it passes, so they live no longer than before. Each watcher is filtered to its own prefix, so a handler never sees the other handler's writes and the tag replay only reads tags.

## Verifying

`mise run demo:verify-cache` starts two replicas and checks that both paths share entries and that `updateTag` on one replica expires the entry on the other.

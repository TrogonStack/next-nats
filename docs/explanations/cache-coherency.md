# Cache coherency

Replicas keep a small in-memory cache in front of NATS. The problem is keeping those copies from serving stale data after another replica changes it.

## Entries

An entry is stored in a KV bucket under the hash of its cache key. Each process holds a byte-bounded LRU of recent entries and runs a watcher on the bucket in headers-only mode. When any replica writes or deletes a key, every watcher sees the new revision. A process evicts its copy if the copy is older than the announced revision, and records the revision so a slow read cannot reinstall an older body afterwards.

Bodies too large for a NATS message are written to the Object Store, and the KV entry holds a pointer. The previous object is removed after the new entry is written.

## Tags

Tag state lives in its own bucket as stale and expired timestamps per tag. Each process watches the bucket, keeps the records in memory and mirrors them into Next.js's tag manifest. Next.js then decides freshness with its usual rules. Updating a tag is a compare-and-set loop, so two replicas updating the same tag do not overwrite each other.

An invalidation on one replica therefore reaches the others as a watch event, within milliseconds when the network is healthy.

## Reconnects and gaps

If the watcher fails or the connection reconnects, the process clears its front cache and starts watching again, so a missed event cannot leave stale data behind. A gap costs extra reads, not wrong answers.

## Two handlers

`'use cache'` and ISR with the fetch cache are separate Next.js interfaces. next-nats installs a handler for each. They share the same connection, tag store and buckets, with separate entry buckets.

## Verifying

`mise run demo:verify-cache` starts two replicas and checks that both paths share entries and that `updateTag` on one replica expires the entry on the other.

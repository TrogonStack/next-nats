export const features = [
  { slug: "kv", title: "KV", blurb: "Vercel KV style client on NATS KV" },
  { slug: "blob", title: "Blob", blurb: "Vercel Blob API on the NATS Object Store" },
  { slug: "queue", title: "Queue", blurb: "Vercel Queues style send and callbacks on JetStream" },
  { slug: "edge-config", title: "Edge Config", blurb: "Read-mostly config with a live watch cache" },
  { slug: "cache", title: "Cache", blurb: "Next cache handlers backed by NATS KV" },
  { slug: "ratelimit", title: "Rate limit", blurb: "Sliding and fixed window limiter on KV" },
  { slug: "realtime", title: "Realtime", blurb: "Server-sent events over subscriptions" },
  { slug: "services", title: "Services", blurb: "NATS micro services called from Server Actions" },
  { slug: "cron", title: "Cron", blurb: "Scheduled jobs on JetStream" },
] as const;

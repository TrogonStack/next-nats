export function isolatedEnv(label: string): Record<string, string> {
  const id = `${label}_${Date.now().toString(36)}`;
  return {
    NEXT_NATS_CACHE_NAMESPACE: id,
    NEXT_NATS_KV_BUCKET: `kv_${id}`,
    NEXT_NATS_EDGE_CONFIG_BUCKET: `edge_${id}`,
    NEXT_NATS_BLOB_BUCKET: `blob_${id}`,
    CRON_SECRET: `cron-${id}`,
  };
}

export function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

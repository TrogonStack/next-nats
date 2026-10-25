import "server-only";
import { Svcm, type ServiceIdentity, type ServiceInfo, type ServiceStats } from "@nats-io/services";
import type { QueuedIterator } from "@nats-io/nats-core";
import { getNats } from "../connection.js";

export interface DiscoverOptions {
  name?: string;
  id?: string;
  timeout?: number;
}

export interface Discovery {
  ping: ServiceIdentity[];
  info: ServiceInfo[];
  stats: ServiceStats[];
}

async function collect<T>(iterator: Promise<QueuedIterator<T>>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of await iterator) out.push(item);
  return out;
}

export async function discover(opts: DiscoverOptions = {}): Promise<Discovery> {
  const { nc } = await getNats();
  const client = new Svcm(nc).client({ strategy: "timer", maxWait: opts.timeout ?? 500 });
  const [ping, info, stats] = await Promise.all([
    collect(client.ping(opts.name, opts.id)),
    collect(client.info(opts.name, opts.id)),
    collect(client.stats(opts.name, opts.id)),
  ]);
  return { ping, info, stats };
}

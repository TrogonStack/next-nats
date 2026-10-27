export interface NatsConnectErrorEvent {
  readonly error: Error;
  readonly kind: "initial" | "auth";
}

export interface NatsDisconnectEvent {
  readonly server: string;
}

export interface NatsReconnectEvent {
  readonly server: string;
  readonly downtimeMs: number;
}

export interface LifecycleEvents {
  connectError: NatsConnectErrorEvent;
  disconnect: NatsDisconnectEvent;
  reconnect: NatsReconnectEvent;
}

type Listeners = { [K in keyof LifecycleEvents]: Set<(event: LifecycleEvents[K]) => void> };

const LIFECYCLE_KEY = Symbol.for("next-nats.lifecycle");

function listeners(): Listeners {
  const g = globalThis as unknown as Record<symbol, Listeners | undefined>;
  return (g[LIFECYCLE_KEY] ??= {
    connectError: new Set(),
    disconnect: new Set(),
    reconnect: new Set(),
  });
}

export function emitLifecycle<K extends keyof LifecycleEvents>(name: K, event: LifecycleEvents[K]): void {
  for (const listener of [...listeners()[name]]) {
    try {
      listener(event);
    } catch {
      continue;
    }
  }
}

function subscribe<K extends keyof LifecycleEvents>(name: K, listener: (event: LifecycleEvents[K]) => void): () => void {
  const set = listeners()[name];
  set.add(listener);
  return () => set.delete(listener);
}

export const onNatsConnectError = (listener: (event: NatsConnectErrorEvent) => void) => subscribe("connectError", listener);
export const onNatsDisconnect = (listener: (event: NatsDisconnectEvent) => void) => subscribe("disconnect", listener);
export const onNatsReconnect = (listener: (event: NatsReconnectEvent) => void) => subscribe("reconnect", listener);

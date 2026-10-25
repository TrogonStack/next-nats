"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type NatsEventsStatus = "connecting" | "open" | "closed";

export interface NatsEvent<T = unknown> {
  id: string;
  event: string;
  data: T;
}

export interface UseNatsEventsProps<T = unknown> {
  url: string | null;
  events?: string[];
  limit?: number;
  enabled?: boolean;
  withCredentials?: boolean;
  minDelay?: number;
  maxDelay?: number;
  onParse?: (raw: string) => T;
  onEvent?: (event: NatsEvent<T>) => void;
}

export interface UseNatsEvents<T> {
  events: NatsEvent<T>[];
  status: NatsEventsStatus;
  lastEventId: string | undefined;
  clear: () => void;
}

function defaultParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function withLastEventId(url: string, id: string | undefined): string {
  if (id === undefined) return url;
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.set("lastEventId", id);
  return parsed.toString();
}

export function useNatsEvents<T = unknown>(props: UseNatsEventsProps<T>): UseNatsEvents<T> {
  const { url, enabled = true, limit = 100, withCredentials, minDelay = 1_000, maxDelay = 30_000 } = props;
  const eventNames = props.events?.join("\u0000") ?? "";
  const [events, setEvents] = useState<NatsEvent<T>[]>([]);
  const [status, setStatus] = useState<NatsEventsStatus>("closed");
  const [lastId, setLastId] = useState<string | undefined>();
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!url || !enabled) {
      setStatus("closed");
      return;
    }
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let id: string | undefined;
    let delay = minDelay;
    let disposed = false;

    const handle = (e: Event) => {
      const message = e as MessageEvent<string>;
      const parse = latest.current.onParse ?? (defaultParse as (raw: string) => T);
      let data: T;
      try {
        data = parse(message.data);
      } catch {
        return;
      }
      if (message.lastEventId) {
        id = message.lastEventId;
        setLastId(id);
      }
      const event: NatsEvent<T> = { id: message.lastEventId, event: message.type, data };
      latest.current.onEvent?.(event);
      const max = latest.current.limit ?? limit;
      if (max > 0) setEvents((prev) => [...prev, event].slice(-max));
    };

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      const es = new EventSource(withLastEventId(url, id), { withCredentials });
      source = es;
      es.onopen = () => {
        delay = minDelay;
        setStatus("open");
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          setStatus("connecting");
          timer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, maxDelay);
        } else {
          setStatus("connecting");
        }
      };
      es.addEventListener("message", handle);
      for (const name of eventNames ? eventNames.split("\u0000") : []) es.addEventListener(name, handle);
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      source?.close();
      setStatus("closed");
    };
  }, [url, enabled, eventNames, limit, withCredentials, minDelay, maxDelay]);

  const clear = useCallback(() => setEvents([]), []);
  return { events, status, lastEventId: lastId, clear };
}

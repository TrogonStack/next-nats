"use client";

import { useEffect, useState } from "react";

export function Live<T>({ url, render, intervalMs = 1000 }: { url: string; render: (data: T) => React.ReactNode; intervalMs?: number }) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const response = await fetch(url, { cache: "no-store" }).catch(() => null);
      if (active && response?.ok) setData((await response.json()) as T);
    };
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [url, intervalMs]);
  return <>{data === null ? "Loading" : render(data)}</>;
}

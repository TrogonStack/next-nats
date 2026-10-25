"use client";

import { useEffect, useRef, useState } from "react";
import { useNatsEvents } from "@trogonstack/next-nats/realtime/client";

interface Cursor {
  id: string;
  x: number;
  y: number;
  name: string;
}

const STALE_MS = 5_000;
const SEND_EVERY_MS = 50;

function hue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function Cursors() {
  const [cursors, setCursors] = useState<Record<string, Cursor & { seen: number }>>({});
  const self = useRef<string>("");
  const lastSent = useRef(0);

  useEffect(() => {
    self.current = crypto.randomUUID();
    const timer = setInterval(() => {
      const cutoff = Date.now() - STALE_MS;
      setCursors((prev) => Object.fromEntries(Object.entries(prev).filter(([, c]) => c.seen > cutoff)));
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  const { status } = useNatsEvents<Cursor>({
    url: "/api/realtime/cursors",
    limit: 0,
    onEvent: ({ data }) => setCursors((prev) => ({ ...prev, [data.id]: { ...data, seen: Date.now() } })),
  });

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const now = Date.now();
    if (!self.current || now - lastSent.current < SEND_EVERY_MS) return;
    lastSent.current = now;
    const box = e.currentTarget.getBoundingClientRect();
    void fetch("/api/realtime/cursors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: self.current, x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height }),
    });
  };

  return (
    <section style={{ display: "grid", gap: "0.5rem" }}>
      <small>
        {status}, {Object.keys(cursors).length} cursor(s). Move the pointer in the box and open another tab.
      </small>
      <div
        onPointerMove={move}
        style={{ position: "relative", height: 240, border: "1px solid #888", borderRadius: 6, overflow: "hidden", touchAction: "none" }}
      >
        {Object.values(cursors).map((c) => (
          <span
            key={c.id}
            style={{
              position: "absolute",
              left: `${c.x * 100}%`,
              top: `${c.y * 100}%`,
              transform: "translate(-4px, -4px)",
              background: `hsl(${hue(c.id)} 70% 45%)`,
              color: "white",
              fontSize: 11,
              padding: "1px 5px",
              borderRadius: 4,
              pointerEvents: "none",
              transition: "left 60ms linear, top 60ms linear",
            }}
          >
            {c.id === self.current ? "you" : c.name}
          </span>
        ))}
      </div>
    </section>
  );
}

"use client";

import { useNatsEvents } from "next-nats/realtime/client";
import { publishFeed } from "./_server/actions/realtime";

interface FeedMessage {
  text: string;
  at: string;
}

export function Feed() {
  const { events, status, lastEventId } = useNatsEvents<FeedMessage>({ url: "/api/realtime/feed", limit: 50 });
  return (
    <section style={{ display: "grid", gap: "0.75rem" }}>
      <form action={publishFeed} style={{ display: "flex", gap: "0.5rem" }}>
        <input name="text" placeholder="Say something" required style={{ flex: 1 }} />
        <button>Publish</button>
      </form>
      <small>
        {status}, last event id {lastEventId ?? "none"}
      </small>
      <ul style={{ paddingLeft: "1.25rem", display: "grid", gap: "0.25rem" }}>
        {[...events].reverse().map((e) => (
          <li key={e.id}>
            <code>#{e.id}</code> {e.data.text} <small>{new Date(e.data.at).toLocaleTimeString()}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

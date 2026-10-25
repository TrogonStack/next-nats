import { features } from "@/constants/features";
import { Cursors } from "./cursors.client";
import { Feed } from "./feed.client";

const feature = features.find((f) => f.slug === "realtime")!;

export default function Page() {
  return (
    <main style={{ display: "grid", gap: "1.5rem" }}>
      <header>
        <h1>{feature.title}</h1>
        <p>{feature.blurb}</p>
      </header>
      <section style={{ display: "grid", gap: "0.5rem" }}>
        <h2>Live feed</h2>
        <p>
          Backed by a JetStream stream and one ordered ephemeral consumer per tab. Reload the page and the history
          replays; a dropped connection resumes from the last event id.
        </p>
        <Feed />
      </section>
      <section style={{ display: "grid", gap: "0.5rem" }}>
        <h2>Live cursors</h2>
        <p>Core NATS pub/sub relayed over SSE, no persistence.</p>
        <Cursors />
      </section>
    </main>
  );
}

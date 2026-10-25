import { features } from "@/lib/features";
import { HitForm } from "./form";

const feature = features.find((f) => f.slug === "ratelimit")!;

export default function Page() {
  return (
    <main>
      <h1>{feature.title}</h1>
      <p>{feature.blurb}</p>
      <h2>Server Action</h2>
      <HitForm />
      <h2>Route Handler</h2>
      <p>
        <a href="/api/ratelimit">/api/ratelimit</a> answers 429 with <code>X-RateLimit-*</code> headers after 5 requests per 10 seconds per client.
      </p>
    </main>
  );
}

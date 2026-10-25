import Link from "next/link";
import { features } from "@/lib/features";
import { PublishForm } from "./publish/form";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>next-nats</h1>
      <p>Vercel platform primitives running on NATS.</p>
      <ul style={{ paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
        {features.map((f) => (
          <li key={f.slug}>
            <Link href={`/${f.slug}`}>{f.title}</Link> <small>{f.blurb}</small>
          </li>
        ))}
      </ul>
      <h2>Publish</h2>
      <PublishForm />
    </main>
  );
}

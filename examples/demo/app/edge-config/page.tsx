import { connection } from "next/server";
import { digest, getAll } from "next-nats/edge-config";
import { features } from "@/lib/features";
import { DeleteForm, UpsertForm } from "./forms";

const feature = features.find((f) => f.slug === "edge-config")!;

export default async function Page() {
  await connection();
  const started = performance.now();
  const [items, hash] = await Promise.all([getAll(), digest()]);
  const micros = Math.round((performance.now() - started) * 1000);
  return (
    <main>
      <h1>{feature.title}</h1>
      <p>{feature.blurb}</p>
      <p>
        Read {Object.keys(items).length} items from the in-process mirror in {micros}µs. Digest <code>{hash}</code>
      </p>
      <pre>{JSON.stringify(items, null, 2)}</pre>
      <h2>Write</h2>
      <UpsertForm />
      <h2>Delete</h2>
      <DeleteForm />
    </main>
  );
}

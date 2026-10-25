import { features } from "@/lib/features";

const feature = features.find((f) => f.slug === "edge-config")!;

export default function Page() {
  return (
    <main>
      <h1>{feature.title}</h1>
      <p>{feature.blurb}</p>
      <p>Not implemented yet.</p>
    </main>
  );
}

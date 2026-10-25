import { features } from "@/lib/features";
import { EnqueueForm } from "./form";
import { QueueLog } from "./log";

const feature = features.find((f) => f.slug === "queue")!;

export default function Page() {
  return (
    <main>
      <h1>{feature.title}</h1>
      <p>{feature.blurb}</p>
      <EnqueueForm />
      <h2>Processed</h2>
      <QueueLog />
    </main>
  );
}

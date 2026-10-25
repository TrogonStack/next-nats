import { features } from "@/constants/features";
import { EnqueueForm } from "./form.client";
import { QueueLog } from "./log.client";

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

import { features } from "@/constants/features";
import { CronRuns } from "./runs.client";

const feature = features.find((f) => f.slug === "cron")!;

export default function Page() {
  return (
    <main>
      <h1>{feature.title}</h1>
      <p>{feature.blurb}</p>
      <p>
        <code>heartbeat-beater</code> runs every minute. Each tick executes on exactly one replica.
      </p>
      <CronRuns />
    </main>
  );
}

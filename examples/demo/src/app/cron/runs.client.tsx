"use client";

import { Live } from "@/components/live.client";
import type { CronRun } from "next-nats/cron";

export function CronRuns() {
  return (
    <>
      <button onClick={() => fetch("/cron/runs", { method: "POST" })}>Run now</button>
      <Live<CronRun[]>
        url="/cron/runs"
        onRender={(runs) =>
          runs.length === 0 ? (
            <p>No runs yet. The next tick fires at the top of the minute.</p>
          ) : (
            <ul style={{ paddingLeft: "1.25rem" }}>
              {runs.map((run) => (
                <li key={`${run.scheduledAt}-${run.startedAt}`}>
                  {run.scheduledAt.slice(11, 19)} {run.status} <small>on {run.replica}</small>
                </li>
              ))}
            </ul>
          )
        }
      />
    </>
  );
}

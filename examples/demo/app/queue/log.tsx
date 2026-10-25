"use client";

import { Live } from "@/lib/live";
import type { QueueLogLine } from "@/lib/demo-log";

export function QueueLog() {
  return (
    <Live<QueueLogLine[]>
      url="/queue/log"
      render={(lines) =>
        lines.length === 0 ? (
          <p>No jobs processed yet.</p>
        ) : (
          <ul style={{ paddingLeft: "1.25rem" }}>
            {lines.map((line, i) => (
              <li key={`${line.messageId}-${line.deliveryCount}-${i}`}>
                {line.at.slice(11, 19)} {line.outcome} "{line.text}" <small>delivery {line.deliveryCount}</small>
              </li>
            ))}
          </ul>
        )
      }
    />
  );
}

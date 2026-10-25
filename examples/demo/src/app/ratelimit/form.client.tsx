"use client";

import { useActionState } from "react";
import { hit, type LimitState } from "./_server/actions/ratelimit";

const initial: LimitState = { lines: [] };

export function HitForm() {
  const [state, action, pending] = useActionState(hit, initial);
  return (
    <form action={action} style={{ display: "grid", gap: "0.5rem", maxWidth: 360 }}>
      <select name="algo" defaultValue="sliding">
        <option value="sliding">sliding window: 5 per 10s</option>
        <option value="fixed">fixed window: 5 per 10s</option>
        <option value="bucket">token bucket: 5 max, +1 per 2s</option>
      </select>
      <input name="identifier" placeholder="identifier (e.g. an IP)" defaultValue="demo-user" />
      <button disabled={pending}>Hit it</button>
      <pre>{state.lines.join("\n")}</pre>
    </form>
  );
}

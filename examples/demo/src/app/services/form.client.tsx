"use client";

import { useActionState, useState, useTransition } from "react";
import { calculate, scatter, type CalcState } from "./_server/actions/services";

const initial: CalcState = { ok: true, message: "" };

export function CalcForm() {
  const [state, action, pending] = useActionState(calculate, initial);
  return (
    <form action={action} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
      <input name="a" type="number" step="any" defaultValue={6} required style={{ width: 80 }} />
      <select name="op" defaultValue="add">
        <option value="add">add</option>
        <option value="divide">divide</option>
      </select>
      <input name="b" type="number" step="any" defaultValue={0} required style={{ width: 80 }} />
      <button disabled={pending}>{pending ? "Calling" : "Call"}</button>
      {state.message && <output style={{ color: state.ok ? "inherit" : "crimson" }}>{state.message}</output>}
    </form>
  );
}

export function ScatterButton() {
  const [replies, setReplies] = useState<string[]>([]);
  const [pending, start] = useTransition();
  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <button disabled={pending} onClick={() => start(async () => setReplies(await scatter()))} style={{ justifySelf: "start" }}>
        {pending ? "Gathering" : "Ask every probe instance"}
      </button>
      <ul style={{ paddingLeft: "1.25rem", display: "grid", gap: "0.25rem" }}>
        {replies.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

"use client";

import { useActionState } from "react";
import { deleteItem, upsertItem, type EdgeConfigState } from "./actions";

const initial: EdgeConfigState = { message: "" };
const grid = { display: "grid", gap: "0.5rem", maxWidth: 360 } as const;

export function UpsertForm() {
  const [state, action, pending] = useActionState(upsertItem, initial);
  return (
    <form action={action} style={grid}>
      <input name="key" placeholder="key (e.g. maintenance)" required />
      <input name="value" placeholder='value (JSON or text, e.g. {"banner":"hi"})' />
      <button disabled={pending}>Upsert</button>
      {state.message && <output>{state.message}</output>}
    </form>
  );
}

export function DeleteForm() {
  const [state, action, pending] = useActionState(deleteItem, initial);
  return (
    <form action={action} style={grid}>
      <input name="key" placeholder="key" required />
      <button disabled={pending}>Delete</button>
      {state.message && <output>{state.message}</output>}
    </form>
  );
}

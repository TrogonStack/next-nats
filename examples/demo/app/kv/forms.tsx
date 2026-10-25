"use client";

import { useActionState } from "react";
import { deleteKey, incrementCounter, setKey, setProfileField, type KvState } from "./actions";

const initial: KvState = { message: "" };
const grid = { display: "grid", gap: "0.5rem", maxWidth: 360 } as const;

export function SetForm() {
  const [state, action, pending] = useActionState(setKey, initial);
  return (
    <form action={action} style={grid}>
      <input name="key" placeholder="key (e.g. user:1)" required />
      <input name="value" placeholder='value (JSON or text, e.g. {"a":1})' />
      <input name="ex" type="number" min="0" placeholder="expire after seconds (optional)" />
      <label>
        <input type="checkbox" name="nx" /> only if the key does not exist (NX)
      </label>
      <button disabled={pending}>SET</button>
      {state.message && <output>{state.message}</output>}
    </form>
  );
}

export function DeleteForm() {
  const [state, action, pending] = useActionState(deleteKey, initial);
  return (
    <form action={action} style={grid}>
      <input name="key" placeholder="key" required />
      <button disabled={pending}>DEL</button>
      {state.message && <output>{state.message}</output>}
    </form>
  );
}

export function CounterForm() {
  const [state, action, pending] = useActionState(incrementCounter, initial);
  return (
    <form action={action} style={grid}>
      <input name="by" type="number" defaultValue={1} />
      <button disabled={pending}>INCRBY</button>
      {state.message && <output>{state.message}</output>}
    </form>
  );
}

export function ProfileForm() {
  const [state, action, pending] = useActionState(setProfileField, initial);
  return (
    <form action={action} style={grid}>
      <input name="field" placeholder="field" required />
      <input name="value" placeholder="value" />
      <button disabled={pending}>HSET</button>
      {state.message && <output>{state.message}</output>}
    </form>
  );
}

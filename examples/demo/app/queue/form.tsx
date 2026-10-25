"use client";

import { useActionState } from "react";
import { enqueue, type EnqueueState } from "./actions";

export function EnqueueForm() {
  const [state, action, pending] = useActionState(enqueue, { message: "" } as EnqueueState);
  return (
    <form action={action} style={{ display: "grid", gap: "0.5rem", maxWidth: 360 }}>
      <input name="text" placeholder="Job text" required />
      <label>
        Delay seconds <input name="delay" type="number" min="0" defaultValue="0" style={{ width: 64 }} />
      </label>
      <label>
        <input type="checkbox" name="fail" /> Fail the first two attempts
      </label>
      <button disabled={pending}>{pending ? "Sending" : "Enqueue"}</button>
      {state.message && <output>{state.message}</output>}
    </form>
  );
}

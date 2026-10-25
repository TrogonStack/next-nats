"use client";

import { useActionState } from "react";
import { publishEvent, type PublishState } from "./_server/actions/publish";

const initial: PublishState = { ok: true, message: "" };

export function PublishForm() {
  const [state, action, pending] = useActionState(publishEvent, initial);
  return (
    <form action={action} style={{ display: "grid", gap: "0.5rem", maxWidth: 360 }}>
      <input name="message" placeholder="Message" required />
      <label>
        <input type="checkbox" name="fail" /> Make the consumer fail (dead-letters after 3 tries)
      </label>
      <button disabled={pending}>{pending ? "Publishing" : "Publish"}</button>
      {state.message && <output>{state.message}</output>}
    </form>
  );
}

"use server";
import "server-only";

import { ServiceCallError } from "next-nats/services";
import { calc, prober } from "@/services/nats/service-clients";

export type CalcState = { ok: boolean; message: string };

export async function calculate(_prev: CalcState, formData: FormData): Promise<CalcState> {
  const a = Number(formData.get("a"));
  const b = Number(formData.get("b"));
  const op = formData.get("op") === "divide" ? "divide" : "add";
  try {
    const { result } = await calc()[op]({ a, b });
    return { ok: true, message: `${a} ${op === "add" ? "+" : "/"} ${b} = ${result}` };
  } catch (error) {
    if (error instanceof ServiceCallError) return { ok: false, message: `${error.kind} ${error.code}: ${error.message}` };
    throw error;
  }
}

export async function scatter(): Promise<string[]> {
  const replies = await prober().whoami.gather(undefined, { maxWait: 500 });
  return replies.map((r) => (r.ok ? `${r.value.instance} (pid ${r.value.pid})` : `${r.instance}: ${r.error.message}`));
}

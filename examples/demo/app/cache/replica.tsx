import { connection } from "next/server";

export async function Replica() {
  await connection();
  return <code>port {process.env.PORT ?? "3000"} pid {process.pid}</code>;
}

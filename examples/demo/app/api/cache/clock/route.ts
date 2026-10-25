import { connection } from "next/server";

export async function GET() {
  await connection();
  return Response.json({ at: new Date().toISOString(), nonce: Math.random().toString(36).slice(2, 10) });
}

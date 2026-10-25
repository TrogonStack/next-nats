import { connection } from "next/server";
import { GET as health } from "next-nats/health";

export async function GET(...args: Parameters<typeof health>) {
  await connection();
  return health(...args);
}

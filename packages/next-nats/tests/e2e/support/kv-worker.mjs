import { createClient } from "@trogonstack/next-nats/kv";

const [source, target, operations] = process.argv.slice(2);
const kv = createClient({});
let acknowledged = 0;
let failed = 0;
for (let index = 0; index < Number(operations); index++) {
  try {
    await kv.multi().decrby(source, 1).incrby(target, 1).exec();
    acknowledged++;
  } catch {
    failed++;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
process.stdout.write(JSON.stringify({ acknowledged, failed }));
process.exit(0);

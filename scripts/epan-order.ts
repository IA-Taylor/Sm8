import 'dotenv/config';
import { createEpanClient } from '../src/clients/epan.js';
import { loadConfig } from '../src/config.js';

async function main() {
  const [, , internalId, qtyStr, jobRef] = process.argv;
  if (!internalId || !qtyStr || !jobRef) {
    console.error('usage: tsx scripts/epan-order.ts <internalId> <qty> <jobReference>');
    process.exit(2);
  }
  const cfg = await loadConfig();
  const epan = createEpanClient(cfg);
  const result = await epan.placeOrder({
    internalId,
    qty: parseInt(qtyStr, 10),
    jobReference: jobRef,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

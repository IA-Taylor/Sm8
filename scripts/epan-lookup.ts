import { createEpanClient } from '../src/clients/epan.js';
import { loadConfig } from '../src/config.js';

async function main() {
  const sku = process.argv[2];
  if (!sku) {
    console.error('usage: tsx scripts/epan-lookup.ts <sku>');
    process.exit(2);
  }
  const cfg = await loadConfig();
  const epan = createEpanClient(cfg);
  const quote = await epan.lookup(sku);
  console.log(JSON.stringify(quote, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

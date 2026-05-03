import 'dotenv/config';
import { createEpanClient } from '../src/clients/epan.js';
import { createZunosClient } from '../src/clients/zunos.js';
import { loadConfig } from '../src/config.js';

async function main() {
  const [, , modelNumber, ...partTypeWords] = process.argv;
  const partType = partTypeWords.join(' ');
  if (!modelNumber || !partType) {
    console.error('usage: tsx scripts/zunos-lookup.ts <model> <part type>');
    console.error('example: tsx scripts/zunos-lookup.ts CU-RZ25AKR PCB');
    console.error('example: tsx scripts/zunos-lookup.ts CS-RE15RKR fan motor');
    process.exit(2);
  }

  const cfg = await loadConfig();
  const zunos = createZunosClient(cfg);
  const epan = createEpanClient(cfg);

  console.error(`[1/2] Searching Zunos for "${partType}" in model "${modelNumber}"...`);
  const partNumber = await zunos.findPartInManual(modelNumber, partType);

  if (!partNumber) {
    console.log(
      JSON.stringify(
        {
          found: false,
          modelNumber,
          partType,
          message: 'Zunos lookup did not return a part number',
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  console.error(`[1/2] Zunos returned part number: ${partNumber}`);
  console.error(`[2/2] Looking up "${partNumber}" on EPAN...`);
  const quote = await epan.lookup(partNumber);

  console.log(
    JSON.stringify(
      {
        modelNumber,
        partType,
        resolvedPartNumber: partNumber,
        epanQuote: quote,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

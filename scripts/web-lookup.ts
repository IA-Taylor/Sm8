import 'dotenv/config';
import { createClaudeClient } from '../src/clients/claude.js';
import { createEpanClient } from '../src/clients/epan.js';
import { loadConfig } from '../src/config.js';

async function main() {
  const [, , modelNumber, ...partTypeWords] = process.argv;
  const partType = partTypeWords.join(' ');
  if (!modelNumber || !partType) {
    console.error('usage: tsx scripts/web-lookup.ts <model> <part type>');
    console.error('example: tsx scripts/web-lookup.ts CU-RZ25AKR PCB');
    console.error('example: tsx scripts/web-lookup.ts CS-RE15RKR fan motor');
    process.exit(2);
  }

  const cfg = await loadConfig();
  const claude = createClaudeClient(cfg);
  const epan = createEpanClient(cfg);

  console.error(`[1/2] Asking Claude to find "${partType}" for "${modelNumber}" via web search...`);
  const result = await claude.findPartNumberByWebSearch(modelNumber, partType);

  if (!result.partNumber) {
    console.log(
      JSON.stringify(
        {
          found: false,
          modelNumber,
          partType,
          confidence: result.confidence,
          reasoning: result.reasoning,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  console.error(
    `[1/2] Claude returned part number: ${result.partNumber} ` +
      `(confidence: ${result.confidence})`,
  );
  if (result.source) console.error(`      source: ${result.source}`);
  console.error(`[2/2] Looking up "${result.partNumber}" on EPAN...`);
  const quote = await epan.lookup(result.partNumber);

  console.log(
    JSON.stringify(
      {
        modelNumber,
        partType,
        resolvedPartNumber: result.partNumber,
        confidence: result.confidence,
        reasoning: result.reasoning,
        source: result.source,
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

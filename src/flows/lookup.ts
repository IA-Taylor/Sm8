import type { ClaudeClient } from '../clients/claude.js';
import type { EpanClient } from '../clients/epan.js';
import type { ServiceM8Client } from '../clients/servicem8.js';
import type { ZunosClient } from '../clients/zunos.js';
import type { Store } from '../store.js';
import type { PendingOrder } from '../types.js';
import { runQuote } from './quote.js';

export interface LookupDeps {
  claude: ClaudeClient;
  // Kept for compatibility with the quote flow's enrichment step. The
  // PDF-scraping path is no longer used by the lookup itself.
  zunos: ZunosClient;
  epan: EpanClient;
  sm8: ServiceM8Client;
  store: Store;
  botStaffUuid?: string;
}

export interface LookupInput {
  jobUuid: string;
  modelNumber: string;
  partType: string;
  qty: number;
  requesterStaffUuid?: string;
}

export type LookupOutcome =
  | { kind: 'no_part_found' }
  | { kind: 'quoted'; pending: PendingOrder; source?: string; confidence?: string };

// "Kevin can you find a PCB for a CU-RZ25AKR" → ask Claude (with the
// web_search tool) to find the part number from the public web, then run
// the existing quote flow with it.
//
// This replaces the older Zunos-scraping path. The Zunos client is still
// available in deps for any flow that wants enrichment but the lookup
// itself is now LLM-driven.
export async function runLookup(
  deps: LookupDeps,
  input: LookupInput,
): Promise<LookupOutcome> {
  const result = await deps.claude.findPartNumberByWebSearch(
    input.modelNumber,
    input.partType,
  );

  if (!result.partNumber) {
    await deps.sm8.createTask({
      jobUuid: input.jobUuid,
      description:
        `Kevin couldn't find the ${input.partType} part number for model ${input.modelNumber} ` +
        `via web search. ${result.reasoning ? `(${result.reasoning}) ` : ''}` +
        `Please reply with the exact part number, e.g. "Kevin order <part-number>".`,
      assigneeUuid: input.requesterStaffUuid ?? deps.botStaffUuid,
    });
    return { kind: 'no_part_found' };
  }

  const pending = await runQuote(deps, {
    jobUuid: input.jobUuid,
    partNumber: result.partNumber,
    qty: input.qty,
    requesterStaffUuid: input.requesterStaffUuid,
  });

  // Annotate the SM8 task with the source so the human reviewing the
  // quote can verify the part suggestion before confirming the order.
  if (pending.sm8_task_uuid && (result.source || result.confidence)) {
    const annotation =
      `\n\n(Kevin found this via web search. ` +
      `Confidence: ${result.confidence ?? 'unknown'}.` +
      `${result.source ? ` Source: ${result.source}` : ''})`;
    await deps.sm8
      .postNote(input.jobUuid, `Part lookup detail:${annotation}`, deps.botStaffUuid)
      .catch(() => undefined);
  }

  return {
    kind: 'quoted',
    pending,
    source: result.source,
    confidence: result.confidence,
  };
}

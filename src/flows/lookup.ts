import type { EpanClient } from '../clients/epan.js';
import type { ServiceM8Client } from '../clients/servicem8.js';
import type { ZunosClient } from '../clients/zunos.js';
import type { Store } from '../store.js';
import type { PendingOrder } from '../types.js';
import { runQuote } from './quote.js';

export interface LookupDeps {
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
  | { kind: 'quoted'; pending: PendingOrder };

// "Kevin can you find a PCB for a CU-RZ25AKR" → drive Zunos to find the
// right service manual PDF, fetch it, hand it to Claude (via the Zunos
// client's internal claude dep) to read out the part number, then run
// the existing quote flow with that part number.
//
// Zunos is the source of truth for trade-only Panasonic docs (the data
// isn't on the public web). Claude is the reader, handling the PDF
// layout judgement that regex couldn't do reliably.
export async function runLookup(
  deps: LookupDeps,
  input: LookupInput,
): Promise<LookupOutcome> {
  const partNumber = await deps.zunos.findPartInManual(input.modelNumber, input.partType);

  if (!partNumber) {
    await deps.sm8.createTask({
      jobUuid: input.jobUuid,
      description:
        `Kevin couldn't find the ${input.partType} part number for model ${input.modelNumber} ` +
        `in Zunos. Please reply with the exact part number, e.g. ` +
        `"Kevin order <part-number>".`,
      assigneeUuid: input.requesterStaffUuid ?? deps.botStaffUuid,
    });
    return { kind: 'no_part_found' };
  }

  const pending = await runQuote(deps, {
    jobUuid: input.jobUuid,
    partNumber,
    qty: input.qty,
    requesterStaffUuid: input.requesterStaffUuid,
  });

  return { kind: 'quoted', pending };
}

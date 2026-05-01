import type { EpanClient } from '../clients/epan.js';
import type { ServiceM8Client } from '../clients/servicem8.js';
import type { ZunosClient } from '../clients/zunos.js';
import type { Store } from '../store.js';
import type { PendingOrder } from '../types.js';

export interface QuoteDeps {
  zunos: ZunosClient;
  epan: EpanClient;
  sm8: ServiceM8Client;
  store: Store;
  botStaffUuid?: string;
}

export interface QuoteInput {
  jobUuid: string;
  partNumber: string;
  qty: number;
  requesterStaffUuid?: string;
}

export async function runQuote(deps: QuoteDeps, input: QuoteInput): Promise<PendingOrder> {
  const { zunos, epan, sm8, store, botStaffUuid } = deps;

  const zunosHit = await zunos.searchPart(input.partNumber).catch((err) => {
    console.error('Zunos search failed', err);
    return null;
  });
  const sku = zunosHit?.sku ?? input.partNumber;
  const description = zunosHit?.description ?? input.partNumber;

  const quote = await epan.lookup(sku).catch((err) => {
    console.error('EPAN lookup failed', err);
    return null;
  });

  let taskBody: string;
  let status: PendingOrder['status'];
  if (!quote) {
    status = 'epan_unavailable';
    taskBody =
      `Confirm order: ${description} (qty ${input.qty}). ` +
      `EPAN lookup unavailable — please check stock manually. ` +
      `Reply "Kevin yes please order this part on EPAN" to retry the order.`;
  } else {
    status = 'awaiting_confirmation';
    taskBody =
      `Confirm order: ${description} (qty ${input.qty}) ` +
      `@ $${quote.price.toFixed(2)} ${quote.currency}, EPAN stock ${quote.stock}. ` +
      `Reply "Kevin yes please order this part on EPAN" to proceed.`;
  }

  const { taskUuid } = await sm8.createTask({
    jobUuid: input.jobUuid,
    description: taskBody,
    assigneeUuid: input.requesterStaffUuid ?? botStaffUuid,
  });

  return store.putPending({
    job_uuid: input.jobUuid,
    sku,
    description,
    qty: input.qty,
    epan_internal_id: quote?.internalId ?? null,
    epan_price: quote?.price ?? null,
    epan_stock: quote?.stock ?? null,
    sm8_task_uuid: taskUuid,
    status,
  });
}

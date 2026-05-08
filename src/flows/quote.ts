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

  // Fetch the human-readable SM8 job number so we can stamp it onto the
  // EPAN order as the customer reference. Falls back to the first 8 chars
  // of the UUID if SM8's API doesn't return a generated id.
  const job = await sm8.getJob(input.jobUuid).catch((err) => {
    console.error('SM8 getJob failed', err);
    return null;
  });
  const jobReferenceForEpan = job?.generated_job_id?.trim() || input.jobUuid.slice(0, 8);

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
    const margin = quote.retailPriceIncTax - quote.costPriceExTax;
    taskBody =
      `Confirm order: ${description} (SKU ${sku}, qty ${input.qty})\n` +
      `  Retail price (inc GST): $${quote.retailPriceIncTax.toFixed(2)} ${quote.currency}\n` +
      `  Buy price (ex GST):     $${quote.costPriceExTax.toFixed(2)} ${quote.currency}\n` +
      (margin > 0 ? `  Margin (approx, ex/inc GST mix): $${margin.toFixed(2)}\n` : '') +
      `  EPAN stock: ${quote.stock}\n` +
      `  EPAN order reference will be: ${jobReferenceForEpan}\n` +
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
    epan_retail_price_inc_tax: quote?.retailPriceIncTax ?? null,
    epan_cost_price_ex_tax: quote?.costPriceExTax ?? null,
    epan_stock: quote?.stock ?? null,
    sm8_task_uuid: taskUuid,
    job_reference_for_epan: jobReferenceForEpan,
    status,
  });
}

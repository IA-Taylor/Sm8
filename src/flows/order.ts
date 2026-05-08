import type { EpanClient } from '../clients/epan.js';
import type { ServiceM8Client } from '../clients/servicem8.js';
import type { Store } from '../store.js';

export interface OrderDeps {
  epan: EpanClient;
  sm8: ServiceM8Client;
  store: Store;
  botStaffUuid?: string;
}

export interface OrderInput {
  jobUuid: string;
}

export type OrderOutcome =
  | { kind: 'no_pending' }
  | { kind: 'not_actionable'; reason: string }
  | { kind: 'ordered'; epanOrderRef: string; alreadyPlaced: boolean };

export async function runOrder(deps: OrderDeps, input: OrderInput): Promise<OrderOutcome> {
  const { epan, sm8, store, botStaffUuid } = deps;

  const pending = await store.getLatestPending(input.jobUuid);
  if (!pending) {
    await sm8.postNote(
      input.jobUuid,
      'No pending part order found on this job. Add a note like `order <part-number>` first.',
      botStaffUuid,
    );
    return { kind: 'no_pending' };
  }

  if (pending.status === 'ordered') {
    await sm8.postNote(
      input.jobUuid,
      `This part has already been ordered on EPAN (ref ${pending.epan_order_ref ?? 'unknown'}).`,
      botStaffUuid,
    );
    return { kind: 'not_actionable', reason: 'already_ordered' };
  }

  if (pending.status !== 'awaiting_confirmation' || !pending.epan_internal_id) {
    await sm8.postNote(
      input.jobUuid,
      `Cannot place order: pending quote is in state "${pending.status}". ` +
        `Please re-run the quote with a fresh \`order <part>\` note.`,
      botStaffUuid,
    );
    return { kind: 'not_actionable', reason: pending.status };
  }

  const result = await epan.placeOrder({
    internalId: pending.epan_internal_id,
    qty: pending.qty,
    // Use the human-readable SM8 job number captured at quote time
    // (e.g. "1234" rather than the 36-char UUID). Falls back to a
    // UUID-prefix if the SM8 job didn't have one.
    jobReference: pending.job_reference_for_epan || pending.job_uuid.slice(0, 8),
  });

  await store.markStatus(pending.job_uuid, pending.created_at, 'ordered', result.epanOrderRef);

  if (pending.sm8_task_uuid) {
    await sm8.closeTask(pending.sm8_task_uuid).catch((err) => {
      console.error('SM8 closeTask failed (non-fatal)', err);
    });
  }

  await sm8.postNote(
    input.jobUuid,
    result.alreadyPlaced
      ? `Order was already placed on EPAN (ref ${result.epanOrderRef}). No duplicate created.`
      : `Ordered on EPAN: ${pending.description} (qty ${pending.qty}). Ref ${result.epanOrderRef}.`,
    botStaffUuid,
  );

  return { kind: 'ordered', epanOrderRef: result.epanOrderRef, alreadyPlaced: result.alreadyPlaced };
}

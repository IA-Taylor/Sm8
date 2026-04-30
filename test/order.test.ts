import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runOrder } from '../src/flows/order.js';
import type { EpanClient } from '../src/clients/epan.js';
import type { ServiceM8Client } from '../src/clients/servicem8.js';
import type { Store } from '../src/store.js';
import type { PendingOrder } from '../src/types.js';

function makeStore(initial: PendingOrder[] = []): Store & { rows: PendingOrder[] } {
  const rows = initial.map((r) => ({ ...r }));
  return {
    rows,
    async putPending(o) {
      const row: PendingOrder = { ...o, created_at: new Date().toISOString(), ttl: 1 };
      rows.push(row);
      return row;
    },
    async getLatestPending(jobUuid) {
      return rows.filter((r) => r.job_uuid === jobUuid).at(-1) ?? null;
    },
    async markStatus(jobUuid, createdAt, status, epanOrderRef) {
      const r = rows.find((x) => x.job_uuid === jobUuid && x.created_at === createdAt);
      if (r) {
        r.status = status;
        if (epanOrderRef) r.epan_order_ref = epanOrderRef;
      }
    },
  };
}

const samplePending: PendingOrder = {
  job_uuid: 'job-1',
  created_at: '2026-04-30T00:00:00.000Z',
  sku: 'ABC',
  description: 'Widget',
  qty: 2,
  epan_internal_id: 'p-9001',
  epan_price: 42.5,
  epan_stock: 7,
  sm8_task_uuid: 'task-1',
  status: 'awaiting_confirmation',
  ttl: 1,
};

describe('runOrder', () => {
  let epan: EpanClient;
  let sm8: ServiceM8Client;

  beforeEach(() => {
    epan = {
      lookup: vi.fn(),
      placeOrder: vi.fn().mockResolvedValue({ epanOrderRef: 'EP-555', alreadyPlaced: false }),
    };
    sm8 = {
      verifyWebhook: () => true,
      getJob: vi.fn(),
      createTask: vi.fn(),
      closeTask: vi.fn().mockResolvedValue(undefined),
      postNote: vi.fn().mockResolvedValue({ activityUuid: 'a' }),
    };
  });

  it('places order, closes task, posts confirmation note, and marks ordered', async () => {
    const store = makeStore([samplePending]);

    const out = await runOrder({ epan, sm8, store }, { jobUuid: 'job-1' });

    expect(out).toEqual({ kind: 'ordered', epanOrderRef: 'EP-555', alreadyPlaced: false });
    expect(epan.placeOrder).toHaveBeenCalledWith({
      internalId: 'p-9001',
      qty: 2,
      jobReference: 'job-1',
    });
    expect(sm8.closeTask).toHaveBeenCalledWith('task-1');
    expect(sm8.postNote).toHaveBeenCalled();
    expect(store.rows[0]!.status).toBe('ordered');
    expect(store.rows[0]!.epan_order_ref).toBe('EP-555');
  });

  it('respects EPAN idempotency (alreadyPlaced=true)', async () => {
    (epan.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      epanOrderRef: 'EP-OLD',
      alreadyPlaced: true,
    });
    const store = makeStore([samplePending]);

    const out = await runOrder({ epan, sm8, store }, { jobUuid: 'job-1' });

    expect(out).toEqual({ kind: 'ordered', epanOrderRef: 'EP-OLD', alreadyPlaced: true });
    const noteBody = (sm8.postNote as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(noteBody).toContain('already');
  });

  it('returns no_pending and posts an explanatory note when nothing is pending', async () => {
    const store = makeStore([]);

    const out = await runOrder({ epan, sm8, store }, { jobUuid: 'job-x' });

    expect(out).toEqual({ kind: 'no_pending' });
    expect(epan.placeOrder).not.toHaveBeenCalled();
    expect(sm8.postNote).toHaveBeenCalled();
  });

  it('refuses to re-order an already-ordered row', async () => {
    const store = makeStore([{ ...samplePending, status: 'ordered', epan_order_ref: 'EP-1' }]);

    const out = await runOrder({ epan, sm8, store }, { jobUuid: 'job-1' });

    expect(out).toEqual({ kind: 'not_actionable', reason: 'already_ordered' });
    expect(epan.placeOrder).not.toHaveBeenCalled();
  });

  it('refuses to order from an epan_unavailable row', async () => {
    const store = makeStore([{ ...samplePending, status: 'epan_unavailable', epan_internal_id: null }]);

    const out = await runOrder({ epan, sm8, store }, { jobUuid: 'job-1' });

    expect(out.kind).toBe('not_actionable');
    expect(epan.placeOrder).not.toHaveBeenCalled();
  });
});

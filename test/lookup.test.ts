import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runLookup } from '../src/flows/lookup.js';
import type { EpanClient } from '../src/clients/epan.js';
import type { ServiceM8Client } from '../src/clients/servicem8.js';
import type { ZunosClient } from '../src/clients/zunos.js';
import type { Store } from '../src/store.js';
import type { PendingOrder } from '../src/types.js';

function makeStore(): Store & { rows: PendingOrder[] } {
  const rows: PendingOrder[] = [];
  return {
    rows,
    async putPending(o) {
      const row: PendingOrder = { ...o, created_at: '2026-05-01T00:00:00.000Z', ttl: 1 };
      rows.push(row);
      return row;
    },
    async getLatestPending(jobUuid) {
      return rows.filter((r) => r.job_uuid === jobUuid).at(-1) ?? null;
    },
    async markStatus() {},
  };
}

describe('runLookup', () => {
  let zunos: ZunosClient;
  let epan: EpanClient;
  let sm8: ServiceM8Client;
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    zunos = {
      findPartInManual: vi.fn(),
      searchPart: vi.fn().mockResolvedValue(null),
    };
    epan = {
      lookup: vi.fn().mockResolvedValue({
        internalId: 'CWA73C0001',
        productUrl: 'https://e-pan/product',
        price: 152.5,
        stock: 3,
        currency: 'AUD',
      }),
      placeOrder: vi.fn(),
    };
    sm8 = {
      verifyWebhook: () => true,
      getJob: vi.fn(),
      createTask: vi.fn().mockResolvedValue({ taskUuid: 'task-1' }),
      closeTask: vi.fn(),
      postNote: vi.fn().mockResolvedValue({ activityUuid: 'a-1' }),
    };
    store = makeStore();
  });

  it('happy path: Zunos finds part number → EPAN quote → task created', async () => {
    (zunos.findPartInManual as ReturnType<typeof vi.fn>).mockResolvedValue('CWA73C0001');

    const out = await runLookup(
      { zunos, epan, sm8, store },
      { jobUuid: 'job-1', modelNumber: 'CU-RZ25AKR', partType: 'PCB', qty: 1 },
    );

    expect(out.kind).toBe('quoted');
    expect(zunos.findPartInManual).toHaveBeenCalledWith('CU-RZ25AKR', 'PCB');
    expect(epan.lookup).toHaveBeenCalledWith('CWA73C0001');
    expect(sm8.createTask).toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.sku).toBe('CWA73C0001');
  });

  it('when Zunos finds nothing, posts a clarification task and stores nothing', async () => {
    (zunos.findPartInManual as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const out = await runLookup(
      { zunos, epan, sm8, store },
      { jobUuid: 'job-2', modelNumber: 'OBSCURE-MODEL', partType: 'PCB', qty: 1 },
    );

    expect(out).toEqual({ kind: 'no_part_found' });
    expect(epan.lookup).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
    const taskCall = (sm8.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(taskCall.description).toContain("couldn't find");
    expect(taskCall.description).toContain('OBSCURE-MODEL');
    expect(taskCall.description).toContain('Kevin order');
  });
});

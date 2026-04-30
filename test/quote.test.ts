import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runQuote } from '../src/flows/quote.js';
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
      const row: PendingOrder = {
        ...o,
        created_at: '2026-04-30T00:00:00.000Z',
        ttl: 1,
      };
      rows.push(row);
      return row;
    },
    async getLatestPending(jobUuid) {
      return rows.filter((r) => r.job_uuid === jobUuid).at(-1) ?? null;
    },
    async markStatus() {},
  };
}

describe('runQuote', () => {
  let zunos: ZunosClient;
  let epan: EpanClient;
  let sm8: ServiceM8Client;
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    zunos = {
      searchPart: vi.fn().mockResolvedValue({
        sku: 'ABC-123',
        title: 'Widget',
        description: '10A Widget',
      }),
    };
    epan = {
      lookup: vi.fn().mockResolvedValue({
        internalId: 'p-9001',
        productUrl: 'https://epan/p/9001',
        price: 42.5,
        stock: 7,
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

  it('happy path: writes pending row and creates SM8 task with quote details', async () => {
    const row = await runQuote(
      { zunos, epan, sm8, store },
      { jobUuid: 'job-1', partNumber: 'ABC-123', qty: 2 },
    );

    expect(row.status).toBe('awaiting_confirmation');
    expect(row.epan_internal_id).toBe('p-9001');
    expect(row.epan_price).toBe(42.5);
    expect(row.sm8_task_uuid).toBe('task-1');
    expect(store.rows).toHaveLength(1);

    const taskCall = (sm8.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(taskCall.jobUuid).toBe('job-1');
    expect(taskCall.description).toContain('10A Widget');
    expect(taskCall.description).toContain('$42.50');
    expect(taskCall.description).toContain('stock 7');
    expect(taskCall.description).toContain('yes please order this part on EPAN');
  });

  it('falls back to raw part number when Zunos misses', async () => {
    (zunos.searchPart as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await runQuote(
      { zunos, epan, sm8, store },
      { jobUuid: 'job-2', partNumber: 'RAW-9' },
    );

    expect(epan.lookup).toHaveBeenCalledWith('RAW-9');
    expect(store.rows[0]!.description).toBe('RAW-9');
  });

  it('flags epan_unavailable when EPAN lookup throws', async () => {
    (epan.lookup as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    const row = await runQuote(
      { zunos, epan, sm8, store },
      { jobUuid: 'job-3', partNumber: 'ABC' },
    );

    expect(row.status).toBe('epan_unavailable');
    expect(row.epan_internal_id).toBeNull();
    const taskCall = (sm8.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(taskCall.description).toContain('EPAN lookup unavailable');
  });
});

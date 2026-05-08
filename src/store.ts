import { DefaultAzureCredential } from '@azure/identity';
import { TableClient, type TableEntity } from '@azure/data-tables';
import type { PendingOrder, PendingStatus } from './types.js';

export interface Store {
  putPending(o: Omit<PendingOrder, 'created_at' | 'ttl'>): Promise<PendingOrder>;
  getLatestPending(jobUuid: string): Promise<PendingOrder | null>;
  markStatus(
    jobUuid: string,
    createdAt: string,
    status: PendingStatus,
    epanOrderRef?: string,
  ): Promise<void>;
}

// Azure Table Storage uses RowKey for sort order. Tables sort RowKey
// ascending lexicographically; we want "latest first" so we store
// (Number.MAX_SAFE_INTEGER - epoch_ms) zero-padded as the RowKey.
function rowKeyFromTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  const inverted = (Number.MAX_SAFE_INTEGER - ms).toString().padStart(20, '0');
  return inverted;
}

interface PendingEntity extends TableEntity {
  created_at: string;
  sku: string;
  description: string;
  qty: number;
  epan_internal_id: string | null;
  epan_retail_price_inc_tax: number | null;
  epan_cost_price_ex_tax: number | null;
  epan_stock: number | null;
  sm8_task_uuid: string | null;
  job_reference_for_epan: string;
  status: PendingStatus;
  epan_order_ref?: string;
  ttl: number;
}

function entityToPending(e: PendingEntity): PendingOrder {
  return {
    job_uuid: e.partitionKey,
    created_at: e.created_at,
    sku: e.sku,
    description: e.description,
    qty: e.qty,
    epan_internal_id: e.epan_internal_id,
    epan_retail_price_inc_tax: e.epan_retail_price_inc_tax,
    epan_cost_price_ex_tax: e.epan_cost_price_ex_tax,
    epan_stock: e.epan_stock,
    sm8_task_uuid: e.sm8_task_uuid,
    job_reference_for_epan: e.job_reference_for_epan,
    status: e.status,
    ...(e.epan_order_ref !== undefined ? { epan_order_ref: e.epan_order_ref } : {}),
    ttl: e.ttl,
  };
}

export function createStore(storageAccount: string, tableName: string): Store {
  const url = `https://${storageAccount}.table.core.windows.net`;
  const client = new TableClient(url, tableName, new DefaultAzureCredential());

  return {
    async putPending(o) {
      const created_at = new Date().toISOString();
      const ttl = Math.floor(Date.now() / 1000) + 30 * 86400;
      const row: PendingOrder = { ...o, created_at, ttl };

      const entity: PendingEntity = {
        partitionKey: row.job_uuid,
        rowKey: rowKeyFromTimestamp(created_at),
        ...row,
      };
      await client.createEntity(entity);
      return row;
    },

    async getLatestPending(jobUuid) {
      const iter = client.listEntities<PendingEntity>({
        queryOptions: { filter: `PartitionKey eq '${jobUuid.replace(/'/g, "''")}'` },
      });
      // RowKey is inverted timestamp, so the first row is the latest.
      for await (const entity of iter) {
        return entityToPending(entity);
      }
      return null;
    },

    async markStatus(jobUuid, createdAt, status, epanOrderRef) {
      const rowKey = rowKeyFromTimestamp(createdAt);
      const patch: Partial<PendingEntity> & { partitionKey: string; rowKey: string } = {
        partitionKey: jobUuid,
        rowKey,
        status,
        ...(epanOrderRef !== undefined ? { epan_order_ref: epanOrderRef } : {}),
      };
      await client.updateEntity(patch as PendingEntity, 'Merge');
    },
  };
}

// Lets tests inject a mock — the in-memory store used in flow tests
// doesn't go through this factory, but kept for parity with the AWS version.
export function _setTableClientForTests(_c: unknown): void {
  void _c;
}

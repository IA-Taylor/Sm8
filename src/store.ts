import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { PendingOrder, PendingStatus } from './types.js';

const TTL_DAYS = 30;

let client: DynamoDBDocumentClient | null = null;

function doc(): DynamoDBDocumentClient {
  if (!client) {
    client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return client;
}

export function _setDocClientForTests(c: DynamoDBDocumentClient): void {
  client = c;
}

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

export function createStore(tableName: string): Store {
  return {
    async putPending(o) {
      const created_at = new Date().toISOString();
      const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
      const row: PendingOrder = { ...o, created_at, ttl };
      await doc().send(new PutCommand({ TableName: tableName, Item: row }));
      return row;
    },

    async getLatestPending(jobUuid) {
      const res = await doc().send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'job_uuid = :j',
          ExpressionAttributeValues: { ':j': jobUuid },
          ScanIndexForward: false,
          Limit: 1,
        }),
      );
      const item = res.Items?.[0];
      return (item as PendingOrder | undefined) ?? null;
    },

    async markStatus(jobUuid, createdAt, status, epanOrderRef) {
      const sets = ['#s = :s'];
      const names: Record<string, string> = { '#s': 'status' };
      const values: Record<string, unknown> = { ':s': status };
      if (epanOrderRef !== undefined) {
        sets.push('epan_order_ref = :r');
        values[':r'] = epanOrderRef;
      }
      await doc().send(
        new UpdateCommand({
          TableName: tableName,
          Key: { job_uuid: jobUuid, created_at: createdAt },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    },
  };
}

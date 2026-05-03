export interface Sm8WebhookPayload {
  event_type: string;
  uuid: string;
  job_uuid: string;
  staff_uuid?: string;
  body: string;
  timestamp: string;
}

export interface ZunosPart {
  sku: string;
  title: string;
  description: string;
  url?: string;
}

export interface EpanQuote {
  internalId: string;
  productUrl: string;
  price: number;
  stock: number;
  currency: string;
}

export interface EpanOrderResult {
  epanOrderRef: string;
  alreadyPlaced: boolean;
}

export type PendingStatus = 'awaiting_confirmation' | 'epan_unavailable' | 'ordered' | 'cancelled';

export interface PendingOrder {
  job_uuid: string;
  created_at: string;
  sku: string;
  description: string;
  qty: number;
  epan_internal_id: string | null;
  epan_price: number | null;
  epan_stock: number | null;
  sm8_task_uuid: string | null;
  status: PendingStatus;
  epan_order_ref?: string;
  ttl: number;
}

export type ClassifiedNote =
  | { kind: 'quote'; partNumber: string; qty: number }
  | { kind: 'lookup'; modelNumber: string; partType: string; qty: number }
  | { kind: 'order' }
  | { kind: 'ignore' };

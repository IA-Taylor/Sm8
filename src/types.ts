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
  retailPriceIncTax: number;
  costPriceExTax: number;
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
  epan_retail_price_inc_tax: number | null;
  epan_cost_price_ex_tax: number | null;
  epan_stock: number | null;
  sm8_task_uuid: string | null;
  // Human-readable SM8 job number (e.g. "1234"). Used as the customer
  // order reference when placing the order on EPAN. Falls back to the
  // first 8 chars of job_uuid if the SM8 job lookup couldn't supply it.
  job_reference_for_epan: string;
  status: PendingStatus;
  epan_order_ref?: string;
  ttl: number;
}

export type ClassifiedNote =
  | { kind: 'quote'; partNumber: string; qty: number }
  | { kind: 'lookup'; modelNumber: string; partType: string; qty: number }
  | { kind: 'order' }
  | { kind: 'ignore' };

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';
import { classifyNote } from './classify.js';
import { createEpanClient } from './clients/epan.js';
import { createServiceM8Client } from './clients/servicem8.js';
import { createZunosClient } from './clients/zunos.js';
import { loadConfig } from './config.js';
import { runOrder } from './flows/order.js';
import { runQuote } from './flows/quote.js';
import { createStore } from './store.js';
import type { Sm8WebhookPayload } from './types.js';

export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  context.callbackWaitsForEmptyEventLoop = false;

  const cfg = await loadConfig();
  const sm8 = createServiceM8Client(cfg);

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  const sigHeader =
    event.headers?.['x-servicem8-signature'] ??
    event.headers?.['X-ServiceM8-Signature'] ??
    event.headers?.['x-signature'];

  if (!sm8.verifyWebhook(sigHeader, rawBody)) {
    return { statusCode: 401, body: 'invalid signature' };
  }

  let payload: Sm8WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as Sm8WebhookPayload;
  } catch {
    return { statusCode: 400, body: 'invalid json' };
  }

  if (!payload.job_uuid || !payload.body) {
    return { statusCode: 200, body: 'ignored: missing job_uuid or body' };
  }

  const decision = classifyNote(payload.body);
  if (decision.kind === 'ignore') {
    return { statusCode: 200, body: 'ignored' };
  }

  const zunos = createZunosClient(cfg);
  const epan = createEpanClient(cfg);
  const store = createStore(cfg.pendingOrdersTable);

  try {
    if (decision.kind === 'quote') {
      await runQuote(
        { zunos, epan, sm8, store, botStaffUuid: cfg.sm8BotStaffUuid },
        {
          jobUuid: payload.job_uuid,
          partNumber: decision.partNumber,
          qty: decision.qty,
          requesterStaffUuid: payload.staff_uuid,
        },
      );
    } else {
      await runOrder(
        { epan, sm8, store, botStaffUuid: cfg.sm8BotStaffUuid },
        { jobUuid: payload.job_uuid },
      );
    }
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('flow failed', err);
    await sm8
      .postNote(
        payload.job_uuid,
        `Part-bot failed: ${err instanceof Error ? err.message : String(err)}`,
        cfg.sm8BotStaffUuid,
      )
      .catch(() => undefined);
    return { statusCode: 500, body: 'flow failed' };
  }
}

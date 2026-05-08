import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { classifyNote } from './classify.js';
import { createClaudeClient } from './clients/claude.js';
import { createEpanClient } from './clients/epan.js';
import { createServiceM8Client } from './clients/servicem8.js';
import { createZunosClient } from './clients/zunos.js';
import { loadConfig } from './config.js';
import { runLookup } from './flows/lookup.js';
import { runOrder } from './flows/order.js';
import { runQuote } from './flows/quote.js';
import { createStore } from './store.js';
import type { Sm8WebhookPayload } from './types.js';

export async function sm8Webhook(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const cfg = await loadConfig();
  const sm8 = createServiceM8Client(cfg);

  const rawBody = await request.text();

  const sigHeader =
    request.headers.get('x-servicem8-signature') ??
    request.headers.get('x-signature') ??
    undefined;

  if (!sm8.verifyWebhook(sigHeader, rawBody)) {
    return { status: 401, body: 'invalid signature' };
  }

  let payload: Sm8WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as Sm8WebhookPayload;
  } catch {
    return { status: 400, body: 'invalid json' };
  }

  if (!payload.job_uuid || !payload.body) {
    return { status: 200, body: 'ignored: missing job_uuid or body' };
  }

  const decision = classifyNote(payload.body);
  if (decision.kind === 'ignore') {
    return { status: 200, body: 'ignored' };
  }

  const claude = createClaudeClient(cfg);
  const zunos = createZunosClient(cfg);
  const epan = createEpanClient(cfg);
  const store = createStore(cfg.storageAccountName, cfg.pendingOrdersTable);

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
    } else if (decision.kind === 'lookup') {
      await runLookup(
        { claude, zunos, epan, sm8, store, botStaffUuid: cfg.sm8BotStaffUuid },
        {
          jobUuid: payload.job_uuid,
          modelNumber: decision.modelNumber,
          partType: decision.partType,
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
    return { status: 200, body: 'ok' };
  } catch (err) {
    context.error('flow failed', err);
    await sm8
      .postNote(
        payload.job_uuid,
        `Part-bot failed: ${err instanceof Error ? err.message : String(err)}`,
        cfg.sm8BotStaffUuid,
      )
      .catch(() => undefined);
    return { status: 500, body: 'flow failed' };
  }
}

app.http('sm8Webhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'sm8/webhook',
  handler: sm8Webhook,
});

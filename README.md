# sm8-part-bot

ServiceM8 → Zunos → EPAN automated part-order workflow.

## What it does

When a tech adds a note on a ServiceM8 job:

| Note (case-insensitive)                  | Bot does                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `order ABC-123` (optionally `… 5` for qty) | Looks the part up on Bigtincan Zunos, then on the EPAN B2B portal for price + stock, and creates a To-Do on the job asking for confirmation. |
| `yes please order this part on EPAN`     | Places the previously-quoted order on EPAN, closes the To-Do, and posts a confirmation note with the EPAN order reference. |
| Anything else                            | Ignored.                                                          |

State for the two-step flow lives in a DynamoDB table keyed on `job_uuid`.

## Architecture

```
ServiceM8 webhook → API Gateway → Lambda (Node 20)
                                   ├─ Bigtincan Zunos (REST + OAuth2)
                                   ├─ EPAN portal     (Playwright + @sparticuz/chromium)
                                   ├─ ServiceM8 API   (REST)
                                   └─ DynamoDB        (pending_orders, TTL 30d)
Secrets → AWS SSM Parameter Store under /sm8-part-bot/*
```

## Layout

- `src/handler.ts` — Lambda entry, HMAC verify, classify, dispatch.
- `src/classify.ts` — regex classifier (quote vs order vs ignore).
- `src/flows/quote.ts`, `src/flows/order.ts` — the two flows.
- `src/clients/{servicem8,zunos,epan}.ts` — integration clients.
- `src/store.ts` — DynamoDB pending-orders store.
- `infra/template.yaml` — AWS SAM (API Gateway + Lambda + DynamoDB + IAM).
- `scripts/epan-lookup.ts`, `scripts/epan-order.ts` — local smoke tests.

## Local development

```bash
npm install
npx playwright install chromium  # only needed if running EPAN smoke scripts locally
cp .env.example .env             # fill in for local smoke scripts
npm test
```

## Deploy

```bash
npm install
npm run build
sam build -t infra/template.yaml
sam deploy --guided -t infra/template.yaml
```

The deploy will print a `WebhookUrl` output. Then seed SSM params:

```bash
PREFIX=/sm8-part-bot
aws ssm put-parameter --name $PREFIX/SM8_API_KEY        --type SecureString --value '…'
aws ssm put-parameter --name $PREFIX/SM8_WEBHOOK_SECRET --type SecureString --value '…'
aws ssm put-parameter --name $PREFIX/SM8_BOT_STAFF_UUID --type String       --value '…'
aws ssm put-parameter --name $PREFIX/ZUNOS_BASE_URL     --type String       --value 'https://api.zunos.com'
aws ssm put-parameter --name $PREFIX/ZUNOS_CLIENT_ID    --type SecureString --value '…'
aws ssm put-parameter --name $PREFIX/ZUNOS_CLIENT_SECRET --type SecureString --value '…'
aws ssm put-parameter --name $PREFIX/ZUNOS_SEARCH_PATH  --type String       --value '/v1/content/search'
aws ssm put-parameter --name $PREFIX/EPAN_BASE_URL      --type String       --value 'https://b2b.epan.example'
aws ssm put-parameter --name $PREFIX/EPAN_USERNAME      --type SecureString --value '…'
aws ssm put-parameter --name $PREFIX/EPAN_PASSWORD      --type SecureString --value '…'
```

## Register the SM8 webhook (one-time)

Subscribe the webhook URL emitted by SAM to `job_activity.created`:

```bash
curl -u "$SM8_API_KEY:x" \
  -H 'Content-Type: application/json' \
  -X POST https://api.servicem8.com/api_1.0/event.json \
  -d '{
    "event_type": "job_activity.created",
    "endpoint_url": "<WebhookUrl from SAM>",
    "secret": "<SM8_WEBHOOK_SECRET>"
  }'
```

## End-to-end test

1. On a sandbox SM8 job, add a note: `order ABC-123`.
2. Within ~30 s a To-Do appears containing the Zunos description, EPAN price and stock, and the confirm phrase.
3. Add another note: `yes please order this part on EPAN`.
4. Within ~30 s the To-Do closes and a status note appears with the EPAN order reference.
5. Verify the order in EPAN's order history.

## Known limits (v1)

- One part per `order` note — multi-line orders are not parsed.
- Confirmer cannot say "no" — the To-Do is just left open. A `cancel order` keyword can be added later.
- Failures rely on SM8 webhook retries; there's no internal queue.

## Notes on the EPAN integration

EPAN is **Panasonic e-Pan**, a HATS (Host Access Transformation Services) terminal-emulation skin in front of an AS/400 mainframe. It is *not* a normal e-commerce site:

- The whole app lives at one URL (`/epan/entry`); screens are distinguished by short page codes (HEPR010 home, DLPR002 enquiry, DLPR501 item detail, OEPR002 order header, OEPR003 order lines, OEPR100 order detail).
- Field names are positional (`in_<cursorPos>_<fieldLength>`) and stable per screen layout.
- Buttons map to PF keys (`[enter]`, `[pf3]`, `[pf13]` etc.).
- There is **no traditional cart**. Orders are entered in two phases: header (OEPR002 — sets the customer reference / our SM8 job UUID), then lines (OEPR003 — add item + qty, then `Confirm TOTAL Order` aka PF3 places the order).
- The order ref returned to us is `<prefix><7-digit number>` from two read-only inputs on OEPR100 (e.g. `S1910760`).
- Idempotency check scans DLPR002 for any existing row whose Customer Order Number cell matches our SM8 job UUID before placing a new order.

If Panasonic ever re-skins e-Pan, every selector lives in the `SELECTORS` const at the top of `src/clients/epan.ts`.

# sm8-part-bot

ServiceM8 → Zunos → EPAN automated part-order workflow, deployed on Azure.

## What it does

The bot is named **Kevin**. He only responds when the note starts with his name — anything else gets ignored.

| Note (case-insensitive)                                          | Bot does                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `Kevin order CWA43C2467`                                         | Looks the part up on EPAN for price + stock, creates a To-Do on the job asking for confirmation. |
| `Kevin can you find a PCB for a CU-RZ25AKR` (or similar natural-language model lookup) | Logs into Zunos, searches for the model, picks the most service/parts-manual-looking PDF, extracts the part number for the requested part type, then runs the EPAN price/stock + To-Do flow. |
| `Kevin yes please order this part on EPAN`                       | Places the previously-quoted order on EPAN, closes the To-Do, and posts a confirmation note with the EPAN order reference. |
| Anything else, including `order ABC-123` without "Kevin"         | Ignored.                                                          |

For the natural-language model lookup, recognised part types include: PCB, circuit board, main board, control board, fan motor, capacitor, compressor, sensor, thermistor, relay, valve, filter, pump.

State for the two-step flow lives in an Azure Table Storage table keyed on `job_uuid`.

## Architecture

```
ServiceM8 webhook → Azure Functions (Node 20)
                     ├─ Bigtincan Zunos     (REST + OAuth2)
                     ├─ EPAN portal         (Playwright + @sparticuz/chromium)
                     ├─ ServiceM8 API       (REST)
                     └─ Azure Table Storage (pendingOrders)
Secrets → Azure Key Vault, read at cold-start via Managed Identity
Logs    → Application Insights
```

## Layout

- `src/handler.ts` — Azure Functions HTTP entry; HMAC verify, classify, dispatch.
- `src/classify.ts` — regex classifier (quote vs order vs ignore).
- `src/flows/quote.ts`, `src/flows/order.ts` — the two flows.
- `src/clients/{servicem8,zunos,epan}.ts` — integration clients.
- `src/store.ts` — Azure Table Storage pending-orders store.
- `src/config.ts` — Key Vault + app-settings loader.
- `infra/main.bicep` — Azure infra (Function App + Storage + Key Vault + App Insights + RBAC).
- `host.json`, `local.settings.json.example` — Azure Functions config.
- `scripts/epan-lookup.ts`, `scripts/epan-order.ts` — local smoke tests.

## Prerequisites for deploy

- An Azure subscription with Contributor access on a resource group.
- The Azure CLI: `brew install azure-cli` (or [docs](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)).
- The Azure Functions Core Tools: `brew tap azure/functions && brew install azure-functions-core-tools@4`.
- Node.js 20+.

## Local development

```bash
npm install
npx playwright install chromium  # only needed if running EPAN smoke scripts locally
cp local.settings.json.example local.settings.json   # fill in for `func start`
cp .env.example .env                                  # fill in for the smoke scripts
npm test
```

To run the function locally: `func start`. It listens on `http://localhost:7071/api/sm8/webhook`.

## Deploy

```bash
# 1. Sign in
az login
az account set --subscription "<subscription-name-or-id>"

# 2. Create the resource group (skip if your IT has already made one)
az group create --name sm8-part-bot-rg --location australiaeast

# 3. Provision infra
az deployment group create \
  --resource-group sm8-part-bot-rg \
  --template-file infra/main.bicep

# Note the outputs: functionAppName, webhookUrl, keyVaultName, storageAccountName.

# 4. Seed Key Vault secrets
KV=<keyVaultName from step 3>
az keyvault secret set --vault-name $KV --name sm8-api-key         --value '…'
az keyvault secret set --vault-name $KV --name sm8-webhook-secret  --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name $KV --name zunos-username      --value '…'
az keyvault secret set --vault-name $KV --name zunos-password      --value '…'
az keyvault secret set --vault-name $KV --name epan-username       --value '…'
az keyvault secret set --vault-name $KV --name epan-password       --value '…'

# Save the SM8_WEBHOOK_SECRET value — you need it again to register the webhook.

# 5. Build and publish the function code
npm install
npm run build
func azure functionapp publish <functionAppName from step 3>
```

## Register the SM8 webhook (one-time)

Subscribe the webhook URL emitted by Bicep to `job_activity.created`:

```bash
WEBHOOK_URL='<webhookUrl from deploy outputs>'
SECRET='<the value you set as sm8-webhook-secret>'
SM8_API_KEY='<your ServiceM8 API key>'

curl -u "$SM8_API_KEY:x" \
  -H 'Content-Type: application/json' \
  -X POST https://api.servicem8.com/api_1.0/event.json \
  -d "{
    \"event_type\": \"job_activity.created\",
    \"endpoint_url\": \"$WEBHOOK_URL\",
    \"secret\": \"$SECRET\"
  }"
```

## End-to-end test

1. On a sandbox SM8 job, add a note: `Kevin order <real-EPAN-SKU>`.
2. Within ~30 s a To-Do appears containing the Zunos description, EPAN price and stock, and the confirm phrase.
3. Add another note: `Kevin yes please order this part on EPAN`.
4. Within ~30 s the To-Do closes and a status note appears with the EPAN order reference.
5. Verify the order in EPAN's order history.

Logs stream live with `az webapp log tail --resource-group sm8-part-bot-rg --name <functionAppName>` or via Application Insights in the portal.

## Known limits (v1)

- One part per `order` note — multi-line orders are not parsed.
- Confirmer cannot say "no" — the To-Do is just left open. A `cancel order` keyword can be added later.
- Failures rely on SM8 webhook retries; there's no internal queue.
- Azure Table Storage doesn't support TTL; old `pendingOrders` rows accumulate. A periodic cleanup function or a manual `az storage entity delete` is fine for the foreseeable future.

## Notes on the EPAN integration

EPAN is **Panasonic e-Pan**, a HATS (Host Access Transformation Services) terminal-emulation skin in front of an AS/400 mainframe. It is *not* a normal e-commerce site:

- The whole app lives at one URL (`/epan/entry`); screens are distinguished by short page codes (HEPR010 home, DLPR002 enquiry, DLPR501 item detail, OEPR002 order header, OEPR003 order lines, OEPR100 order detail).
- Field names are positional (`in_<cursorPos>_<fieldLength>`) and stable per screen layout.
- Buttons map to PF keys (`[enter]`, `[pf3]`, `[pf13]` etc.).
- There is **no traditional cart**. Orders are entered in two phases: header (OEPR002 — sets the customer reference / our SM8 job UUID), then lines (OEPR003 — add item + qty, then `Confirm TOTAL Order` aka PF3 places the order).
- The order ref returned to us is `<prefix><7-digit number>` from two read-only inputs on OEPR100 (e.g. `S1910760`).
- Idempotency check scans DLPR002 for any existing row whose Customer Order Number cell matches our SM8 job UUID before placing a new order.

If Panasonic ever re-skins e-Pan, every selector lives in the `SELECTORS` const at the top of `src/clients/epan.ts`.

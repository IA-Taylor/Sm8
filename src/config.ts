import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

export interface Config {
  sm8ApiKey: string;
  sm8WebhookSecret: string;
  sm8BotStaffUuid: string;
  zunosBaseUrl: string;
  zunosUsername: string;
  zunosPassword: string;
  epanBaseUrl: string;
  epanUsername: string;
  epanPassword: string;
  pendingOrdersTable: string;
  storageAccountName: string;
}

let cached: Config | null = null;

// Plain-text config keys (read straight from env, never from Key Vault).
const PLAIN_KEYS = [
  'ZUNOS_BASE_URL',
  'EPAN_BASE_URL',
  'PENDING_ORDERS_TABLE',
  'STORAGE_ACCOUNT_NAME',
  'SM8_BOT_STAFF_UUID',
] as const;

// Secret config keys. Loaded from Key Vault by default; falls back to env
// for local dev (set LOCAL_DEV=true to skip Key Vault entirely).
const SECRET_KEYS = [
  'SM8_API_KEY',
  'SM8_WEBHOOK_SECRET',
  'ZUNOS_USERNAME',
  'ZUNOS_PASSWORD',
  'EPAN_USERNAME',
  'EPAN_PASSWORD',
] as const;

const KEY_MAP: Record<string, keyof Config> = {
  SM8_API_KEY: 'sm8ApiKey',
  SM8_WEBHOOK_SECRET: 'sm8WebhookSecret',
  SM8_BOT_STAFF_UUID: 'sm8BotStaffUuid',
  ZUNOS_BASE_URL: 'zunosBaseUrl',
  ZUNOS_USERNAME: 'zunosUsername',
  ZUNOS_PASSWORD: 'zunosPassword',
  EPAN_BASE_URL: 'epanBaseUrl',
  EPAN_USERNAME: 'epanUsername',
  EPAN_PASSWORD: 'epanPassword',
  PENDING_ORDERS_TABLE: 'pendingOrdersTable',
  STORAGE_ACCOUNT_NAME: 'storageAccountName',
};

export async function loadConfig(): Promise<Config> {
  if (cached) return cached;

  const params: Record<string, string> = {};

  // Plain settings always come from env (Function App app-settings or .env).
  for (const k of PLAIN_KEYS) {
    params[k] = process.env[k] ?? '';
  }

  // Secrets: Key Vault in cloud, env in local dev.
  const localDev = process.env.LOCAL_DEV === 'true' || !process.env.KEY_VAULT_URL;
  if (localDev) {
    for (const k of SECRET_KEYS) {
      params[k] = process.env[k] ?? '';
    }
  } else {
    const vaultUrl = process.env.KEY_VAULT_URL!;
    const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
    for (const k of SECRET_KEYS) {
      const secretName = k.replace(/_/g, '-').toLowerCase();
      try {
        const secret = await client.getSecret(secretName);
        params[k] = secret.value ?? '';
      } catch (err) {
        // 404 = secret hasn't been set. Treat as empty string — the
        // individual clients (Zunos optional, SM8/EPAN required) will
        // validate the keys they actually need at construction time.
        const status =
          (err as { statusCode?: number }).statusCode ??
          (err as { code?: string }).code;
        if (status === 404 || status === 'SecretNotFound') {
          console.warn(`[config] Key Vault secret '${secretName}' not found; treating as empty`);
          params[k] = '';
        } else {
          throw new Error(`Failed to read secret ${secretName} from Key Vault: ${err}`);
        }
      }
    }
  }

  cached = mapParams(params);
  return cached;
}

function mapParams(params: Record<string, string>): Config {
  const out = {} as Config;
  for (const [src, dest] of Object.entries(KEY_MAP)) {
    (out as unknown as Record<string, string>)[dest] = params[src] ?? '';
  }
  return out;
}

export function _resetConfigForTests(): void {
  cached = null;
}

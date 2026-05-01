import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

export interface Config {
  sm8ApiKey: string;
  sm8WebhookSecret: string;
  sm8BotStaffUuid: string;
  zunosBaseUrl: string;
  zunosClientId: string;
  zunosClientSecret: string;
  zunosSearchPath: string;
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
  'ZUNOS_SEARCH_PATH',
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
  'ZUNOS_CLIENT_ID',
  'ZUNOS_CLIENT_SECRET',
  'EPAN_USERNAME',
  'EPAN_PASSWORD',
] as const;

const KEY_MAP: Record<string, keyof Config> = {
  SM8_API_KEY: 'sm8ApiKey',
  SM8_WEBHOOK_SECRET: 'sm8WebhookSecret',
  SM8_BOT_STAFF_UUID: 'sm8BotStaffUuid',
  ZUNOS_BASE_URL: 'zunosBaseUrl',
  ZUNOS_CLIENT_ID: 'zunosClientId',
  ZUNOS_CLIENT_SECRET: 'zunosClientSecret',
  ZUNOS_SEARCH_PATH: 'zunosSearchPath',
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
        throw new Error(`Failed to read secret ${secretName} from Key Vault: ${err}`);
      }
    }
  }

  cached = mapParams(params);
  return cached;
}

function mapParams(params: Record<string, string>): Config {
  const out = {} as Config;
  for (const [src, dest] of Object.entries(KEY_MAP)) {
    const v = params[src];
    if (!v && dest !== 'sm8BotStaffUuid') {
      throw new Error(`Missing required config: ${src}`);
    }
    (out as unknown as Record<string, string>)[dest] = v ?? '';
  }
  return out;
}

export function _resetConfigForTests(): void {
  cached = null;
}

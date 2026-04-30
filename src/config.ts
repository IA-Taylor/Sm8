import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';

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
}

let cached: Config | null = null;

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
};

export async function loadConfig(): Promise<Config> {
  if (cached) return cached;

  // In tests / local dev: read straight from process.env.
  if (process.env.SM8_API_KEY) {
    cached = readFromEnv();
    return cached;
  }

  const prefix = process.env.SSM_PREFIX ?? '/sm8-part-bot';
  const client = new SSMClient({});
  const params: Record<string, string> = {};
  let nextToken: string | undefined;
  do {
    const out = await client.send(
      new GetParametersByPathCommand({
        Path: prefix,
        WithDecryption: true,
        Recursive: false,
        NextToken: nextToken,
      }),
    );
    for (const p of out.Parameters ?? []) {
      if (!p.Name || p.Value === undefined) continue;
      const short = p.Name.slice(prefix.length).replace(/^\//, '');
      params[short] = p.Value;
    }
    nextToken = out.NextToken;
  } while (nextToken);

  cached = mapParams(params);
  return cached;
}

function readFromEnv(): Config {
  const params: Record<string, string> = {};
  for (const k of Object.keys(KEY_MAP)) {
    params[k] = process.env[k] ?? '';
  }
  return mapParams(params);
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

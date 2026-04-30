import type { Config } from '../config.js';
import type { ZunosPart } from '../types.js';

export interface ZunosClient {
  searchPart(partNumber: string): Promise<ZunosPart | null>;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

export function createZunosClient(cfg: Config): ZunosClient {
  let token: TokenCache | null = null;

  async function getToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 30_000) return token.token;
    const res = await fetch(`${cfg.zunosBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.zunosClientId,
        client_secret: cfg.zunosClientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Zunos token: ${res.status} ${await res.text().catch(() => '')}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    token = {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return token.token;
  }

  return {
    async searchPart(partNumber) {
      const t = await getToken();
      const url = new URL(cfg.zunosSearchPath, cfg.zunosBaseUrl);
      url.searchParams.set('q', partNumber);
      url.searchParams.set('limit', '1');

      const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`Zunos search: ${res.status} ${await res.text().catch(() => '')}`);
      }
      const json = (await res.json()) as {
        results?: Array<{ sku?: string; title?: string; description?: string; url?: string }>;
      };
      const first = json.results?.[0];
      if (!first) return null;
      return {
        sku: first.sku ?? partNumber,
        title: first.title ?? partNumber,
        description: first.description ?? first.title ?? partNumber,
        url: first.url,
      };
    },
  };
}

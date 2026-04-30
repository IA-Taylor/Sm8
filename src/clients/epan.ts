import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { Config } from '../config.js';
import type { EpanOrderResult, EpanQuote } from '../types.js';

export interface EpanClient {
  lookup(sku: string): Promise<EpanQuote | null>;
  placeOrder(args: {
    internalId: string;
    qty: number;
    jobReference: string;
  }): Promise<EpanOrderResult>;
}

// Selectors are kept in one place so UI changes are a single-file fix.
// These are placeholders that must be tuned against the live EPAN portal
// during the EPAN smoke test step from the plan.
const SELECTORS = {
  loginUser: 'input[name="username"]',
  loginPass: 'input[name="password"]',
  loginSubmit: 'button[type="submit"]',
  loginSuccessIndicator: 'a[href*="logout"]',
  searchInput: 'input[name="search"]',
  searchSubmit: 'button[name="searchSubmit"]',
  productLink: 'a.product-tile',
  productPrice: '[data-test="price"]',
  productStock: '[data-test="stock"]',
  productInternalId: '[data-product-id]',
  qtyInput: 'input[name="qty"]',
  addToCartBtn: 'button.add-to-cart',
  cartLink: 'a[href*="/cart"]',
  checkoutBtn: 'button.checkout',
  poReferenceInput: 'input[name="customer_reference"]',
  placeOrderBtn: 'button.place-order',
  orderConfirmRef: '[data-test="order-reference"]',
  orderHistoryLink: 'a[href*="/orders"]',
  orderHistoryRow: 'tr.order-row',
  orderHistoryRef: '[data-test="reference"]',
  orderHistoryEpanRef: '[data-test="epan-ref"]',
};

const COOKIE_PATH = '/tmp/epan-cookies.json';

export function createEpanClient(cfg: Config): EpanClient {
  async function withSession<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const { browser, context, page } = await openSession(cfg);
    try {
      return await fn(page);
    } finally {
      await persistCookies(context);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  return {
    async lookup(sku) {
      return withSession(async (page) => {
        await page.fill(SELECTORS.searchInput, sku);
        await page.click(SELECTORS.searchSubmit);
        await page.waitForLoadState('networkidle');

        const link = await page.$(SELECTORS.productLink);
        if (!link) return null;
        await link.click();
        await page.waitForLoadState('networkidle');

        const priceText = (await page.textContent(SELECTORS.productPrice)) ?? '';
        const stockText = (await page.textContent(SELECTORS.productStock)) ?? '';
        const internalId =
          (await page.getAttribute(SELECTORS.productInternalId, 'data-product-id')) ?? '';

        return {
          internalId,
          productUrl: page.url(),
          price: parsePrice(priceText),
          stock: parseStock(stockText),
          currency: detectCurrency(priceText),
        };
      });
    },

    async placeOrder({ internalId, qty, jobReference }) {
      return withSession(async (page) => {
        // Idempotency: if an order with this reference already exists, short-circuit.
        const existing = await findOrderByReference(page, cfg, jobReference);
        if (existing) return { epanOrderRef: existing, alreadyPlaced: true };

        await page.goto(`${cfg.epanBaseUrl}/product/${encodeURIComponent(internalId)}`);
        await page.waitForLoadState('networkidle');

        await page.fill(SELECTORS.qtyInput, String(qty));
        await page.click(SELECTORS.addToCartBtn);
        await page.click(SELECTORS.cartLink);
        await page.waitForLoadState('networkidle');

        await page.click(SELECTORS.checkoutBtn);
        await page.waitForLoadState('networkidle');

        await page.fill(SELECTORS.poReferenceInput, jobReference);
        await page.click(SELECTORS.placeOrderBtn);
        await page.waitForLoadState('networkidle');

        const ref = (await page.textContent(SELECTORS.orderConfirmRef))?.trim();
        if (!ref) throw new Error('EPAN: order placed but no confirmation reference scraped');
        return { epanOrderRef: ref, alreadyPlaced: false };
      });
    },
  };
}

async function openSession(cfg: Config): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const { chromium } = await loadChromium();
  const browser = await chromium.launch();
  const context = await browser.newContext();

  if (existsSync(COOKIE_PATH)) {
    try {
      const cookies = JSON.parse(readFileSync(COOKIE_PATH, 'utf8'));
      await context.addCookies(cookies);
    } catch {
      // ignore; fall through to fresh login
    }
  }

  const page = await context.newPage();
  await page.goto(cfg.epanBaseUrl);
  await page.waitForLoadState('networkidle');

  if (!(await page.$(SELECTORS.loginSuccessIndicator))) {
    await page.fill(SELECTORS.loginUser, cfg.epanUsername);
    await page.fill(SELECTORS.loginPass, cfg.epanPassword);
    await page.click(SELECTORS.loginSubmit);
    await page.waitForLoadState('networkidle');
    if (!(await page.$(SELECTORS.loginSuccessIndicator))) {
      throw new Error('EPAN: login failed');
    }
  }

  return { browser, context, page };
}

async function persistCookies(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies();
    writeFileSync(COOKIE_PATH, JSON.stringify(cookies));
  } catch {
    // best-effort; not fatal
  }
}

async function findOrderByReference(
  page: Page,
  cfg: Config,
  reference: string,
): Promise<string | null> {
  await page.goto(`${cfg.epanBaseUrl}/orders`);
  await page.waitForLoadState('networkidle');
  const rows = await page.$$(SELECTORS.orderHistoryRow);
  for (const row of rows) {
    const ref = (await row.$eval(SELECTORS.orderHistoryRef, (el) => el.textContent ?? '')).trim();
    if (ref === reference) {
      const epanRef = (
        await row.$eval(SELECTORS.orderHistoryEpanRef, (el) => el.textContent ?? '')
      ).trim();
      return epanRef || ref;
    }
  }
  return null;
}

function parsePrice(text: string): number {
  const m = /([0-9][0-9,]*\.?[0-9]*)/.exec(text);
  if (!m) return NaN;
  return parseFloat(m[1]!.replace(/,/g, ''));
}

function parseStock(text: string): number {
  const m = /(-?\d+)/.exec(text);
  if (!m) return 0;
  return parseInt(m[1]!, 10);
}

function detectCurrency(text: string): string {
  if (text.includes('$')) return 'AUD';
  if (text.includes('£')) return 'GBP';
  if (text.includes('€')) return 'EUR';
  return 'AUD';
}

// Lazy-load chromium only when actually opening a browser, so tests that
// stub the EpanClient don't need to install playwright.
async function loadChromium(): Promise<{ chromium: typeof import('playwright-core').chromium }> {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const sparticuz = await import('@sparticuz/chromium');
    const { chromium } = await import('playwright-core');
    const exec = await sparticuz.default.executablePath();
    const args = sparticuz.default.args;
    const launchOptions = { args, executablePath: exec, headless: true } as const;
    // Wrap chromium.launch so callers don't need to pass args.
    const wrapped = {
      ...chromium,
      launch: (opts: Parameters<typeof chromium.launch>[0] = {}) =>
        chromium.launch({ ...launchOptions, ...opts }),
    } as typeof chromium;
    // The path/join import is here to keep formatters happy if used later.
    void join;
    return { chromium: wrapped };
  }
  const { chromium } = await import('playwright-core');
  return { chromium };
}

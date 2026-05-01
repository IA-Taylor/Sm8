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

// Panasonic e-Pan is a HATS (Host Access Transformation Services) terminal-
// emulation skin over an AS/400. The whole app lives at one URL (/epan/entry)
// and screens are distinguished by short page codes (HEPR010 home, DLPR002
// item/order enquiry, DLPR501 item detail, OEPR002 order header, OEPR003
// order lines, OEPR100 order detail). Field names are positional
// (in_<cursorPos>_<fieldLength>) and stable per screen layout.
//
// All selectors below were captured against the live portal with Claude for
// Chrome. If the page layout changes, every selector is in this one const.
const SELECTORS = {
  // Login page
  loginUser: "input[name='in_1319_10']",
  loginPass: "input[type='password']",
  loginSubmit: "input[name='[enter]'][class='TealHostButton']",
  loginSuccessIndicator: "a[name='OFF']",

  // Home menu (HEPR010) — entry points to the two flows we care about
  navOrderEntry: "a[name='DC202']", // → OEPR002 (order header)
  navItemOrderEnquiry: "a[name='DC211']", // → DLPR002 (item / order search)

  // Item / Order Enquiry (DLPR002)
  itemNumberInput: "input[name='in_335_20']",
  stockEnquiryBtn: "input[name='[pf13]']", // takes us to DLPR501

  // Item Detail (DLPR501)
  productPrice: "tr:nth-child(11) td.HGREEN[colspan='11']:first-of-type",
  productStock: "td.HCYAN[colspan='8']",
  productInternalId: "input[name='in_248_20']",

  // Order Header (OEPR002)
  customerOrderNumberInput: "input[name='in_995_40']",

  // Order Lines / "cart" (OEPR003)
  lineItemInput: "input[name='in_728_20']",
  lineQtyInput: "input[name='in_749_8']",
  enterBtn: "input[name='[enter]'][class='TealHostButton']",
  confirmTotalOrderBtn: "input[name='[pf3]'][value='Confirm TOTAL Order']",

  // Order Detail / confirmation (OEPR100)
  confirmRefPrefix: "input[name='in_174_1']",
  confirmRefNumber: "input[name='in_176_7']",

  // Order history rows on DLPR002
  orderHistoryRow: "tr:has(select.HATSDROPDOWN option[value='5'])",
  orderHistoryCustomerRefCell: "td.HGREEN[colspan='15']",
  orderHistoryPaRefCell: "td.HGREEN[colspan='8']",
};

const COOKIE_PATH = '/tmp/epan-cookies.json';
const SCREEN_TIMEOUT_MS = 30_000;

export function createEpanClient(cfg: Config): EpanClient {
  if (!cfg.epanBaseUrl || !cfg.epanUsername || !cfg.epanPassword) {
    throw new Error(
      'EPAN config missing: set EPAN_BASE_URL, EPAN_USERNAME, EPAN_PASSWORD',
    );
  }

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
        try {
          await navigateToScreen(page, SELECTORS.navItemOrderEnquiry, 'DLPR002');
        } catch (err) {
          await dumpDiagnostics(page, 'lookup-no-DLPR002');
          throw err;
        }

        await page.fill(SELECTORS.itemNumberInput, sku.toUpperCase());
        await page.click(SELECTORS.stockEnquiryBtn);
        if (!(await waitForScreen(page, 'DLPR501'))) {
          await dumpDiagnostics(page, 'lookup-no-DLPR501');
          console.error(
            `[epan.lookup] never reached DLPR501 after PF13 for sku ${sku}. ` +
              `See /tmp/epan-debug-lookup-no-DLPR501.png`,
          );
          return null;
        }

        const greenCells = await page.locator('td.HGREEN').allTextContents();
        const cyanCells = await page.locator('td.HCYAN').allTextContents();

        const priceText = findValueAfterLabel(greenCells, 'Price extax');
        const stockText = findValueAfterLabel(cyanCells, 'Available');
        const internalId =
          (await page.inputValue(SELECTORS.productInternalId).catch(() => '')) || sku.toUpperCase();

        const price = parsePrice(priceText);
        if (!isFinite(price) || price === 0) {
          await dumpDiagnostics(page, 'lookup-bad-price');
          console.error(
            `[epan.lookup] reached DLPR501 but could not parse a valid price.\n` +
              `  priceText: ${JSON.stringify(priceText)}\n` +
              `  stockText: ${JSON.stringify(stockText)}\n` +
              `  internalId: ${JSON.stringify(internalId)}\n` +
              `  all HGREEN cell texts: ${JSON.stringify(greenCells)}\n` +
              `  all HCYAN cell texts:  ${JSON.stringify(cyanCells)}\n` +
              `See /tmp/epan-debug-lookup-bad-price.png`,
          );
          return null;
        }

        return {
          internalId: internalId.trim(),
          productUrl: page.url(),
          price,
          stock: parseStock(stockText),
          currency: 'AUD',
        };
      });
    },

    async placeOrder({ internalId, qty, jobReference }) {
      // Idempotency check first — runs in its own session so navigation can't
      // collide with the order-entry session below.
      const existing = await withSession((page) =>
        findOrderByCustomerRef(page, jobReference),
      ).catch((err) => {
        console.error('EPAN idempotency check failed (continuing)', err);
        return null;
      });
      if (existing) {
        return { epanOrderRef: existing, alreadyPlaced: true };
      }

      return withSession(async (page) => {
        // 1. Order Entry → OEPR002 (header)
        await navigateToScreen(page, SELECTORS.navOrderEntry, 'OEPR002');

        // 2. Stamp the customer order number with our SM8 job reference
        //    (the field accepts up to 40 chars; SM8 UUIDs are 36).
        await page.fill(SELECTORS.customerOrderNumberInput, jobReference);
        await page.click(SELECTORS.enterBtn);

        // 3. Wait for OEPR003 (line entry)
        if (!(await waitForScreen(page, 'OEPR003'))) {
          throw new Error('EPAN: did not reach OEPR003 line-entry screen');
        }

        // 4. Add the line: item number + qty, then submit
        await page.fill(SELECTORS.lineItemInput, internalId.toUpperCase());
        await page.fill(SELECTORS.lineQtyInput, String(qty));
        await page.click(SELECTORS.enterBtn);
        await page.waitForLoadState('networkidle');

        // 5. Confirm the whole order (PF3) — this is the real "place order"
        await page.click(SELECTORS.confirmTotalOrderBtn);

        // 6. Wait for the confirmation screen and read the PA Ref
        if (!(await waitForScreen(page, 'OEPR100'))) {
          throw new Error('EPAN: order submitted but OEPR100 confirmation never appeared');
        }
        const prefix = (await page.inputValue(SELECTORS.confirmRefPrefix).catch(() => '')) ?? '';
        const number = (await page.inputValue(SELECTORS.confirmRefNumber).catch(() => '')) ?? '';
        const epanOrderRef = `${prefix.trim()}${number.trim()}`;
        if (!epanOrderRef) {
          throw new Error('EPAN: order placed but PA Ref could not be read from OEPR100');
        }
        return { epanOrderRef, alreadyPlaced: false };
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
  const headless = process.env.HEADLESS !== 'false';
  const slowMo = process.env.SLOWMO ? Number(process.env.SLOWMO) : undefined;
  const browser = await chromium.launch({ headless, ...(slowMo ? { slowMo } : {}) });
  const context = await browser.newContext();

  // Cookie reuse made the script flaky: HATS sessions are sticky and
  // restoring cookies can land us mid-flow on a screen our login check
  // doesn't recognise. Always start with a clean login.
  void existsSync;
  void readFileSync;
  void COOKIE_PATH;

  const page = await context.newPage();
  // The HATS servlet always lives at /epan/entry — navigating to the bare
  // host can land somewhere else.
  const entryUrl = cfg.epanBaseUrl.replace(/\/$/, '') + '/epan/entry';
  await page.goto(entryUrl);
  await page.waitForLoadState('networkidle');

  if (await page.$(SELECTORS.loginSuccessIndicator)) {
    return { browser, context, page };
  }

  try {
    await page.waitForSelector(SELECTORS.loginUser, { timeout: 15_000 });
  } catch {
    await dumpDiagnostics(page, 'login-form-not-found');
    throw new Error(
      `EPAN: login form not found at ${page.url()}. ` +
        `A screenshot and HTML snapshot were saved to /tmp/epan-debug.* for inspection.`,
    );
  }

  await page.fill(SELECTORS.loginUser, cfg.epanUsername.toUpperCase());
  await page.fill(SELECTORS.loginPass, cfg.epanPassword);
  await page.click(SELECTORS.loginSubmit);
  await page.waitForLoadState('networkidle');
  if (!(await page.$(SELECTORS.loginSuccessIndicator))) {
    await dumpDiagnostics(page, 'login-failed');
    throw new Error('EPAN: login submitted but the post-login indicator never appeared');
  }

  return { browser, context, page };
}

async function dumpDiagnostics(page: Page, tag: string): Promise<void> {
  try {
    await page.screenshot({ path: `/tmp/epan-debug-${tag}.png`, fullPage: true });
    const html = await page.content();
    writeFileSync(`/tmp/epan-debug-${tag}.html`, html);
  } catch {
    // best-effort; don't mask the real error
  }
}

async function persistCookies(context: BrowserContext): Promise<void> {
  // Disabled — see openSession comment. Kept as no-op so the call sites
  // don't need to change.
  void context;
  void writeFileSync;
}

// HATS lays cells out as siblings on long flat rows: a label cell, often
// some empty padding cells, then the value cell. To read the value for a
// given label, find the cell whose trimmed text equals the label, then
// scan the next few cells for one that contains a digit.
function findValueAfterLabel(cells: string[], label: string): string {
  const trimmed = cells.map((t) => t.trim());
  const idx = trimmed.findIndex((t) => t === label);
  if (idx < 0) return '';
  const window = Math.min(trimmed.length, idx + 6);
  for (let i = idx + 1; i < window; i++) {
    const text = trimmed[i];
    if (text && /\d/.test(text)) return text;
  }
  return '';
}

// Click a home-menu link and wait for the expected screen code to render.
// Assumes the session is currently sitting on HEPR010 (post-login home).
async function navigateToScreen(page: Page, linkSelector: string, screenCode: string): Promise<void> {
  await page.click(linkSelector);
  if (!(await waitForScreen(page, screenCode))) {
    throw new Error(`EPAN: did not reach screen ${screenCode}`);
  }
}

// Wait for a HATS screen code to appear anywhere on the page. HATS swaps
// the body content in place rather than navigating, so we have to poll for
// the marker rather than relying on URL changes.
async function waitForScreen(page: Page, code: string): Promise<boolean> {
  try {
    await page.locator(`text=${code}`).first().waitFor({ timeout: SCREEN_TIMEOUT_MS });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

// Scan DLPR002 for an existing order whose Customer Order Number matches
// our SM8 job UUID. Returns the EPAN PA Ref if found, else null.
async function findOrderByCustomerRef(page: Page, reference: string): Promise<string | null> {
  await navigateToScreen(page, SELECTORS.navItemOrderEnquiry, 'DLPR002');

  const rows = await page.$$(SELECTORS.orderHistoryRow);
  for (const row of rows) {
    const cells = await row.$$(SELECTORS.orderHistoryCustomerRefCell);
    let matched = false;
    for (const cell of cells) {
      const text = ((await cell.textContent()) ?? '').trim();
      if (text === reference) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    const paCell = await row.$(SELECTORS.orderHistoryPaRefCell);
    const paRef = ((await paCell?.textContent()) ?? '').trim();
    if (paRef) return paRef;
    return reference; // fallback: at least we know it's already placed
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

// Lazy-load chromium only when actually opening a browser, so tests that
// stub the EpanClient don't need to install playwright.
async function loadChromium(): Promise<{ chromium: typeof import('playwright-core').chromium }> {
  // Use @sparticuz/chromium when running in any serverless container
  // (Azure Functions, AWS Lambda) where shipping a full Chromium would
  // blow the package size budget. Local dev uses a system chromium.
  const isServerless =
    !!process.env.WEBSITE_INSTANCE_ID || // Azure Functions / App Service
    !!process.env.AWS_LAMBDA_FUNCTION_NAME;

  if (isServerless) {
    const sparticuz = await import('@sparticuz/chromium');
    const { chromium } = await import('playwright-core');
    const exec = await sparticuz.default.executablePath();
    const args = sparticuz.default.args;
    const launchOptions = { args, executablePath: exec, headless: true } as const;
    const wrapped = {
      ...chromium,
      launch: (opts: Parameters<typeof chromium.launch>[0] = {}) =>
        chromium.launch({ ...launchOptions, ...opts }),
    } as typeof chromium;
    void join;
    return { chromium: wrapped };
  }
  const { chromium } = await import('playwright-core');
  return { chromium };
}

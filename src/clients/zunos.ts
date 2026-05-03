import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pdfParse from 'pdf-parse';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { Config } from '../config.js';
import type { ZunosPart } from '../types.js';

function log(msg: string): void {
  console.error(`[zunos] ${msg}`);
}

async function dumpDiagnostic(page: Page, tag: string): Promise<void> {
  try {
    const path = `/tmp/zunos-debug-${tag}`;
    await page.screenshot({ path: `${path}.png`, fullPage: true });
    const html = await page.content();
    writeFileSync(`${path}.html`, html);
    log(`saved diagnostic to ${path}.{png,html}`);
  } catch {
    // best-effort
  }
}

export interface ZunosClient {
  // Find a part number for a given model + part type by:
  //   1. logging into the Zunos web app
  //   2. searching for the model number
  //   3. picking the most service-manual-looking PDF result
  //   4. intercepting the signed PDF URL on Zunos's CDN
  //   5. fetching the PDF bytes and extracting text
  //   6. matching the part type label against a nearby part-number-shaped token
  //
  // Returns null when any step fails (no manual found, PDF unreadable,
  // no matching part). The caller falls back to asking the human for
  // the part number directly.
  findPartInManual(modelNumber: string, partType: string): Promise<string | null>;

  // Optional: enrich a known part number with a Zunos description.
  // Currently always returns null because we don't have the Zunos REST API.
  // Kept for compatibility with the quote flow.
  searchPart(partNumber: string): Promise<ZunosPart | null>;
}

const SELECTORS = {
  // Landing-page button that opens the login modal
  loginOpenModal: 'button.btn-lg.btn-primary.btn-round',
  loginUser: 'input[name="Username"]',
  loginPass: 'input[name="Password"]',
  // The "Next" button on each step of the modal is a span, not a real button
  loginNext: 'zn-login span.clickable',
  // After step 1 (username), pick "Type password" (skip the magic-link option)
  loginUseTypePassword: 'button.btn-outline-white.btn-round',
  loginSuccessIndicator: 'zn-avatar-image',

  // Search nav + input
  navSearch: '.nav-bar-items a:nth-child(4)',
  searchInput: 'input.search-panel-field',
  searchSubmit: 'button.search-panel-button:first-of-type',

  // Result tiles
  resultsContainer: 'div.search-main',
  resultItem: '.catalog-list-item.catalog-list-item-action',
  resultTitle: '.catalog-list-item.catalog-list-item-action .catalog-text-bold',
  resultPdfIcon: 'img.zn-icon[src*="icon_content_type_pdf"]',
  resultPdfTile:
    '.catalog-list-item.catalog-list-item-action:has(img.zn-icon[src*="icon_content_type_pdf"])',
};

const PDF_FETCH_TIMEOUT_MS = 30_000;
const SCREEN_TIMEOUT_MS = 30_000;
const COOKIE_PATH = '/tmp/zunos-cookies.json';

export function createZunosClient(cfg: Config): ZunosClient {
  const configured = !!(cfg.zunosBaseUrl && cfg.zunosUsername && cfg.zunosPassword);
  if (!configured) {
    const missing = [
      !cfg.zunosBaseUrl && 'ZUNOS_BASE_URL',
      !cfg.zunosUsername && 'ZUNOS_USERNAME',
      !cfg.zunosPassword && 'ZUNOS_PASSWORD',
    ]
      .filter(Boolean)
      .join(', ');
    log(`Zunos client disabled - missing config: ${missing}`);
    return {
      async findPartInManual() {
        log(`findPartInManual called but Zunos client is disabled (missing: ${missing})`);
        return null;
      },
      async searchPart() {
        return null;
      },
    };
  }

  async function withSession<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const { browser, context, page } = await openSession(cfg);
    try {
      return await fn(page);
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  return {
    async searchPart() {
      return null;
    },

    async findPartInManual(modelNumber, partType) {
      try {
        return await withSession(async (page) => {
          log(`looking for "${partType}" in model "${modelNumber}"`);

          // Set up the request listener BEFORE we click into the PDF, so we
          // catch the signed URL the moment it's fetched.
          const signedUrlPromise = page
            .waitForRequest(
              (req) =>
                req.url().includes('content.zunos.com') && req.url().includes('.pdf'),
              { timeout: PDF_FETCH_TIMEOUT_MS },
            )
            .catch(() => null);

          log('navigating to Search');
          try {
            await navigateToSearch(page);
          } catch (err) {
            log(`failed to reach Search: ${err}`);
            await dumpDiagnostic(page, 'no-search');
            return null;
          }

          log(`running search for "${modelNumber}"`);
          await runSearch(page, modelNumber);

          const pickedTitle = await pickAndOpenBestPdf(page, partType);
          if (!pickedTitle) {
            await dumpDiagnostic(page, 'no-pdf-results');
            return null;
          }
          log(`opened PDF: "${pickedTitle}"`);

          const signedUrlReq = await signedUrlPromise;
          if (!signedUrlReq) {
            log(`never observed a content.zunos.com PDF fetch for model ${modelNumber}`);
            await dumpDiagnostic(page, 'no-signed-url');
            return null;
          }
          log(`got signed PDF URL: ${signedUrlReq.url().slice(0, 100)}...`);

          const pdfBytes = await fetchSignedPdf(signedUrlReq.url(), page);
          if (!pdfBytes) {
            log('PDF download returned empty');
            return null;
          }
          log(`downloaded PDF: ${pdfBytes.byteLength} bytes`);

          const text = await extractPdfText(pdfBytes);
          if (!text) {
            log('PDF text extraction returned empty');
            return null;
          }
          log(`extracted ${text.length} chars of text from PDF`);
          // Stash the text for inspection if the regex misses
          try {
            writeFileSync('/tmp/zunos-debug-extracted.txt', text);
          } catch {
            // best-effort
          }

          const partNumber = findPartNumberInText(text, partType);
          if (!partNumber) {
            log(
              `no part number found near "${partType}" keyword in PDF "${pickedTitle}". ` +
                `Extracted text saved to /tmp/zunos-debug-extracted.txt for inspection.`,
            );
            return null;
          }

          log(`found part number: ${partNumber}`);
          return partNumber;
        });
      } catch (err) {
        log(`findPartInManual threw: ${err}`);
        return null;
      }
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
  const page = await context.newPage();

  await page.goto(cfg.zunosBaseUrl);
  await page.waitForLoadState('networkidle');

  // Already-logged-in path: reuse session if avatar visible
  if (await page.$(SELECTORS.loginSuccessIndicator)) {
    return { browser, context, page };
  }

  // Three-step modal login
  await page.click(SELECTORS.loginOpenModal).catch(() => undefined);
  await page.waitForSelector(SELECTORS.loginUser, { timeout: SCREEN_TIMEOUT_MS });

  await page.fill(SELECTORS.loginUser, cfg.zunosUsername);
  await page.locator(SELECTORS.loginNext).last().click();

  // Step 2: pick the password auth method
  await page
    .waitForSelector(SELECTORS.loginUseTypePassword, { timeout: SCREEN_TIMEOUT_MS })
    .catch(() => undefined);
  await page.click(SELECTORS.loginUseTypePassword).catch(() => undefined);

  // Step 3: enter password
  await page.waitForSelector(SELECTORS.loginPass, { timeout: SCREEN_TIMEOUT_MS });
  await page.fill(SELECTORS.loginPass, cfg.zunosPassword);
  await page.locator(SELECTORS.loginNext).last().click();

  await page
    .waitForSelector(SELECTORS.loginSuccessIndicator, { timeout: SCREEN_TIMEOUT_MS })
    .catch(() => {
      throw new Error('Zunos: login flow finished but avatar never appeared');
    });

  // Mark cookie path as referenced (placeholder for future session reuse).
  void COOKIE_PATH;

  return { browser, context, page };
}

async function navigateToSearch(page: Page): Promise<void> {
  await page.click(SELECTORS.navSearch);
  await page.waitForSelector(SELECTORS.searchInput, { timeout: SCREEN_TIMEOUT_MS });
}

async function runSearch(page: Page, query: string): Promise<void> {
  await page.fill(SELECTORS.searchInput, query);
  // Pressing Enter is more reliable than clicking the submit button across UI variants.
  await page.locator(SELECTORS.searchInput).press('Enter');
  await page.waitForLoadState('networkidle');
}

// Score each PDF result by how service-manual-looking its title is, click
// the highest-scoring one, and return its title. Returns null if no PDF
// result was visible.
async function pickAndOpenBestPdf(page: Page, partType: string): Promise<string | null> {
  await page
    .waitForSelector(SELECTORS.resultPdfTile, { timeout: 10_000 })
    .catch(() => undefined);

  const tiles = await page.$$(SELECTORS.resultPdfTile);
  if (tiles.length === 0) {
    log('no PDF result tiles found on the search results page');
    return null;
  }

  log(`found ${tiles.length} PDF result(s) on the page; scoring them...`);
  let bestIdx = 0;
  let bestScore = -Infinity;
  let bestTitle = '';
  for (let i = 0; i < tiles.length; i++) {
    const titleEl = await tiles[i]!.$('.catalog-text-bold');
    const title = ((await titleEl?.textContent()) ?? '').trim();
    const score = scorePdfTitle(title, partType);
    log(`  [${i}] score=${score}  title="${title}"`);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
      bestTitle = title;
    }
  }

  log(`picking [${bestIdx}] (score=${bestScore}): "${bestTitle}"`);
  await tiles[bestIdx]!.click();
  await page.waitForLoadState('networkidle');
  return bestTitle;
}

// Higher score = more likely to be the right document for finding parts.
export function scorePdfTitle(title: string, partType: string): number {
  const t = title.toLowerCase();
  let score = 0;
  if (t.includes('spare parts') || t.includes('parts list')) score += 10;
  if (t.includes('service manual')) score += 8;
  if (t.includes(partType.toLowerCase())) score += 5;
  if (t.includes('service')) score += 3;
  if (t.includes('manual')) score += 2;
  if (t.includes('install')) score -= 2; // installation guide unlikely to have parts
  if (t.includes('brochure') || t.includes('catalogue')) score -= 4;
  return score;
}

async function fetchSignedPdf(url: string, page: Page): Promise<Buffer | null> {
  try {
    // Reuse the session's cookies / storage by issuing the fetch from the page context.
    const result = await page.evaluate(async (target) => {
      const res = await fetch(target);
      if (!res.ok) return null;
      const buffer = await res.arrayBuffer();
      // Encode as base64 string to ferry across the playwright bridge.
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
      return btoa(binary);
    }, url);
    if (!result) return null;
    return Buffer.from(result, 'base64');
  } catch (err) {
    console.error('[zunos.fetchSignedPdf] failed:', err);
    return null;
  }
}

async function extractPdfText(bytes: Buffer): Promise<string | null> {
  try {
    const parsed = await pdfParse(bytes);
    return parsed.text ?? '';
  } catch (err) {
    console.error('[zunos.extractPdfText] pdf-parse failed:', err);
    return null;
  }
}

// Search the extracted PDF text for the requested part type, then look for
// a part-number-shaped token in nearby text. Heuristic but covers the
// common parts-list layout: "PCB ASSY ........ CWA73C0001"
export function findPartNumberInText(text: string, partType: string): string | null {
  const partKeywords = expandPartTypeKeywords(partType);
  const partTokenRe = /\b[A-Z][A-Z0-9]{2,}(?:[-/.][A-Z0-9]+)*\b/g;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const upper = line.toUpperCase();
    if (!partKeywords.some((kw) => upper.includes(kw))) continue;

    // Scan this line and the next two for a likely part-number token.
    const window = lines.slice(i, Math.min(lines.length, i + 3)).join(' ').toUpperCase();
    const matches = window.match(partTokenRe) ?? [];
    for (const candidate of matches) {
      // Reject pure model-number-shaped tokens that are obviously the model itself
      if (partKeywords.some((kw) => candidate.includes(kw))) continue;
      // Require at least one digit AND at least 6 characters total
      if (candidate.length < 6) continue;
      if (!/\d/.test(candidate)) continue;
      return candidate;
    }
  }
  return null;
}

function expandPartTypeKeywords(partType: string): string[] {
  const t = partType.toUpperCase();
  const variants = new Set<string>([t]);
  if (t === 'PCB' || t.includes('CIRCUIT') || t.includes('BOARD')) {
    variants.add('PCB');
    variants.add('CIRCUIT BOARD');
    variants.add('PRINTED CIRCUIT');
    variants.add('CONTROL BOARD');
    variants.add('MAIN BOARD');
    variants.add('ELECTRONIC CONTROLLER');
  }
  if (t.includes('FAN')) {
    variants.add('FAN MOTOR');
    variants.add('FAN');
  }
  if (t.includes('CAPACITOR')) {
    variants.add('CAPACITOR');
    variants.add('CAP.');
  }
  if (t.includes('COMPRESSOR')) {
    variants.add('COMPRESSOR');
    variants.add('COMP.');
  }
  if (t.includes('SENSOR') || t.includes('THERMISTOR')) {
    variants.add('SENSOR');
    variants.add('THERMISTOR');
  }
  return [...variants];
}

// Lazy chromium loader (matches the EPAN client's pattern).
async function loadChromium(): Promise<{ chromium: typeof import('playwright-core').chromium }> {
  const isServerless =
    !!process.env.WEBSITE_INSTANCE_ID || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

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

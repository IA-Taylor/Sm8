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

          log(`tiered-searching for "${modelNumber}"`);
          let resultCount = 0;
          try {
            resultCount = await tieredSearch(page, modelNumber);
          } catch (err) {
            log(`tieredSearch failed: ${err}`);
            await dumpDiagnostic(page, 'search-failed');
            return null;
          }
          if (resultCount === 0) {
            log(`no PDF results for any search tier of "${modelNumber}"`);
            await dumpDiagnostic(page, 'no-results-any-tier');
            return null;
          }

          // Cookie / consent banners sometimes only appear after navigation.
          await dismissCookieBanner(page);

          const pickedTitle = await pickAndOpenBestPdf(page, partType, modelNumber);
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

  // Cookie / consent banner can intercept clicks on the login modal
  await dismissCookieBanner(page);

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

  // Wait for any signal that we're past the login modal. The avatar is the
  // canonical post-login element, but the modal disappearing OR the URL
  // moving past the bare hash is also strong evidence.
  const loggedIn = await waitForLoggedIn(page);
  if (!loggedIn) {
    await dumpDiagnostic(page, 'login-failed');
    log(`page URL at login-failed time: ${page.url()}`);
    throw new Error(
      'Zunos: login flow finished but no post-login indicator appeared. ' +
        'Diagnostic saved to /tmp/zunos-debug-login-failed.{png,html}',
    );
  }
  log('login confirmed (post-login indicator visible)');

  // Some banners only appear post-login (e.g. "We use cookies on the dashboard").
  await dismissCookieBanner(page);

  // Mark cookie path as referenced (placeholder for future session reuse).
  void COOKIE_PATH;

  return { browser, context, page };
}

// Click the "See All" link inside the search-results group that contains
// PDF tiles, so we score the entire Media list (not just the default 3).
// Best-effort: if the link can't be found, leave the results as-is and let
// the scorer work with what's visible.
async function expandMediaResults(page: Page): Promise<void> {
  // Tier the selectors from most-specific (Media group containing a PDF)
  // to least, so we don't accidentally click "See All" on a non-PDF section.
  const candidates = [
    '.search-group:has(img.zn-icon[src*="icon_content_type_pdf"]) .search-group-see-all',
    '[class*="search-group"]:has(img.zn-icon[src*="icon_content_type_pdf"]) [class*="see-all"]',
    '.search-group-see-all',
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        log(`clicking "See All" via: ${sel}`);
        await loc.click({ timeout: 3000 });
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1500);
        return;
      }
    } catch {
      // try next candidate
    }
  }
  log('no "See All" link visible — scoring whatever PDFs are on screen');
}

// Best-effort dismissal of cookie / consent banners. Tries a list of
// common "Accept" button patterns; silently moves on if nothing matches.
async function dismissCookieBanner(page: Page): Promise<void> {
  const candidates = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept Cookies")',
    'button:has-text("Accept")',
    'button:has-text("Allow all")',
    'button:has-text("Allow All")',
    'button:has-text("Allow")',
    'button:has-text("Got it")',
    'button:has-text("I accept")',
    'button:has-text("OK")',
    'button:has-text("Agree")',
    '[id*="cookie" i] button',
    '[id*="consent" i] button',
    '[class*="cookie" i] button',
    '[class*="consent" i] button',
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 500 })) {
        log(`dismissing cookie/consent banner via: ${sel}`);
        await loc.click({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      // try next candidate
    }
  }
}

async function waitForLoggedIn(page: Page): Promise<boolean> {
  try {
    await Promise.race([
      // Original: avatar in top nav
      page.waitForSelector(SELECTORS.loginSuccessIndicator, { timeout: SCREEN_TIMEOUT_MS }),
      // Fallback: the <zn-login> element disappears once the modal closes
      page.waitForSelector('zn-login', { state: 'detached', timeout: SCREEN_TIMEOUT_MS }),
      // Fallback: URL moves into the SPA (e.g. /#/board/...)
      page.waitForURL((url) => /\/#\/(board|catalog|search|library)/.test(url.toString()), {
        timeout: SCREEN_TIMEOUT_MS,
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function navigateToSearch(page: Page): Promise<void> {
  await page.click(SELECTORS.navSearch);
  await page.waitForSelector(SELECTORS.searchInput, { timeout: SCREEN_TIMEOUT_MS });
}

async function runSearch(page: Page, query: string): Promise<void> {
  // Clear any existing search text first so this query replaces it.
  await page.fill(SELECTORS.searchInput, '');
  await page.fill(SELECTORS.searchInput, query);

  // Zunos requires clicking the "Search" text in the top-right of the search
  // bar to actually fire the search; pressing Enter alone leaves the UI in
  // its empty-state "type and click Search" placeholder. Try the explicit
  // text locator first; fall back to Enter as a backstop.
  const searchByText = page.getByText('Search', { exact: true }).first();
  const clicked = await searchByText
    .click({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);

  if (clicked) {
    log('clicked the "Search" text element');
  } else {
    log('"Search" text element not found, pressing Enter as fallback');
    await page.locator(SELECTORS.searchInput).press('Enter').catch(() => undefined);
  }

  // Wait for either result tiles to appear or a "no results" message.
  // Some result types load asynchronously, so give the page a beat to render.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
}

// Search Zunos in tiers, broadening the query if narrower ones return
// nothing. Stops at the first tier that yields PDF results.
//
// For CU-RZ25AKR:
//   tier 1: "CU-RZ25AKR"   (exact)
//   tier 2: "RZ25AKR"      (drop the prefix — Zunos doc titles often do)
//   tier 3: "RZ AKR"       (series + suffix, family search)
async function tieredSearch(page: Page, modelNumber: string): Promise<number> {
  const tiers = buildSearchTiers(modelNumber);
  for (const query of tiers) {
    log(`searching: "${query}"`);
    await runSearch(page, query);
    const count = (await page.$$(SELECTORS.resultPdfTile)).length;
    log(`  -> ${count} PDF result(s)`);
    if (count > 0) return count;
  }
  return 0;
}

export function buildSearchTiers(modelNumber: string): string[] {
  const tiers = new Set<string>();
  tiers.add(modelNumber);

  const noPrefix = modelNumber.replace(/^[A-Z]+-/, '');
  if (noPrefix !== modelNumber) tiers.add(noPrefix);

  const decoded = decodeModelStructure(modelNumber);
  if (decoded) {
    tiers.add(`${decoded.series} ${decoded.suffix}`);
  }
  return [...tiers];
}

// Parse a Panasonic model number into structured parts.
//   CU-RZ25AKR  -> { prefix: 'CU', series: 'RZ', capacity: 25, suffix: 'AKR' }
//   CS-RZ50TKR  -> { prefix: 'CS', series: 'RZ', capacity: 50, suffix: 'TKR' }
//   S-160PE1R5A -> { prefix: 'S',  series: '',   capacity: 160, suffix: 'PE1R5A' }
//   U-160PE2R8A -> { prefix: 'U',  series: '',   capacity: 160, suffix: 'PE2R8A' }
export function decodeModelStructure(modelNumber: string):
  | { prefix: string; series: string; capacity: number; suffix: string }
  | null {
  const m = /^(?:([A-Z]+)-)?([A-Z]*?)(\d+)([A-Z][A-Z0-9]*)$/.exec(modelNumber.toUpperCase());
  if (!m) return null;
  return {
    prefix: m[1] ?? '',
    series: m[2] ?? '',
    capacity: parseInt(m[3]!, 10),
    suffix: m[4]!,
  };
}

// Extract a coverage range from a doc title like "S-60-140PE1R5A".
// The document covers capacities lo..hi inclusive.
export function parseCoverageRange(title: string): { lo: number; hi: number } | null {
  // Want the first hyphen-separated number pair where both numbers look like
  // capacity codes (multiples of 5 or common values).
  const m = title.match(/(\d{2,3})\s*-\s*(\d{2,3})/);
  if (!m) return null;
  const lo = parseInt(m[1]!, 10);
  const hi = parseInt(m[2]!, 10);
  // Sanity: real capacities are 25..600 kW
  if (lo < 10 || hi < 10 || lo > 1000 || hi > 1000 || lo >= hi) return null;
  return { lo, hi };
}

// Score each PDF result by how service-manual-looking its title is, click
// the highest-scoring one, and return its title. Returns null if no PDF
// result was visible OR none of them are about the requested model.
async function pickAndOpenBestPdf(
  page: Page,
  partType: string,
  modelNumber: string,
): Promise<string | null> {
  await page
    .waitForSelector(SELECTORS.resultPdfTile, { timeout: 10_000 })
    .catch(() => undefined);

  // Zunos shows only 3 PDFs per group by default. Click the Media section's
  // "See All" link first so we score the full PDF list, not just the top 3.
  await expandMediaResults(page);

  const tiles = await page.$$(SELECTORS.resultPdfTile);
  if (tiles.length === 0) {
    log('no PDF result tiles found on the search results page');
    return null;
  }

  // Read every tile's title up-front so we can log them and filter cleanly.
  const candidates: { idx: number; title: string; score: number; viable: boolean }[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const titleEl = await tiles[i]!.$('.catalog-text-bold');
    const title = ((await titleEl?.textContent()) ?? '').trim();
    const viable = titleMentionsModel(title, modelNumber);
    const score = scorePdfTitle(title, partType, modelNumber);
    candidates.push({ idx: i, title, score, viable });
  }

  log(`found ${tiles.length} PDF result(s); scoring them...`);
  for (const c of candidates) {
    log(`  [${c.idx}] score=${c.score} viable=${c.viable}  title="${c.title}"`);
  }

  // HARD FILTER: only consider PDFs whose title actually mentions the model
  // (full code or model-core after the prefix). Without this the picker
  // would happily click any "X Service Manual" no matter what model X is.
  const viable = candidates.filter((c) => c.viable);
  if (viable.length === 0) {
    log(
      `none of the ${candidates.length} PDF titles mention model "${modelNumber}". ` +
        `Refusing to guess; will fall back to asking the human for the part number.`,
    );
    return null;
  }

  // Among viable candidates, pick the highest scorer.
  viable.sort((a, b) => b.score - a.score);
  const winner = viable[0]!;
  log(`picking [${winner.idx}] (score=${winner.score}): "${winner.title}"`);

  await tiles[winner.idx]!.click();
  await page.waitForLoadState('networkidle');
  return winner.title;
}

// Hard filter: does this PDF title plausibly cover the requested model?
// Three ways to qualify:
//   1. Full model number appears in the title (e.g. "CU-RZ25AKR ...")
//   2. The model "core" (no prefix) appears (e.g. "RZ25AKR ..." for CU-RZ25AKR)
//   3. The title's coverage range includes the target capacity AND the
//      title's suffix matches the model's suffix (e.g. "RZ25-80TKR..." for
//      CS-RZ50TKR — covers 25-80, both have TKR suffix)
export function titleMentionsModel(title: string, modelNumber: string): boolean {
  if (!modelNumber) return false;
  const t = title.toLowerCase();
  const m = modelNumber.toLowerCase();

  if (t.includes(m)) return true;

  const noPrefix = m.replace(/^[a-z]+-/, '');
  if (noPrefix !== m && t.includes(noPrefix)) return true;

  const decoded = decodeModelStructure(modelNumber);
  const range = parseCoverageRange(title);
  if (decoded && range) {
    const inRange = decoded.capacity >= range.lo && decoded.capacity <= range.hi;
    const suffixMatch = decoded.suffix && t.includes(decoded.suffix.toLowerCase());
    if (inRange && suffixMatch) return true;
  }

  return false;
}

// Higher score = more likely to be the right document for finding parts.
//
// Implements the playbook's ranking:
//   doc type (Exploded View > Service Manual > Parts Change > Install > Operating)
// × coverage match (target capacity must fall within title's range)
// × series + suffix match (RZ25-80TKR ≠ RZ25-80AKR — different generations)
export function scorePdfTitle(title: string, partType: string, modelNumber = ''): number {
  const t = title.toLowerCase();
  let score = 0;

  // --- Document type ---
  if (t.includes('exploded view') && t.includes('parts list')) score += 50;
  else if (t.includes('exploded views') && t.includes('parts list')) score += 50;
  else if (t.includes('exploded') || t.includes('parts list')) score += 40;
  else if (t.includes('service manual')) score += 30;
  else if (t.includes('technical data')) score += 25;
  else if (t.includes('parts change') || t.includes('parts notice')) score += 15;
  else if (t.includes('installation')) score += 5;
  else if (t.includes('operating')) score -= 20;
  else if (t.includes('brochure') || t.includes('catalogue')) score -= 10;

  // --- Coverage range check (the trap that catches everyone) ---
  const decoded = decodeModelStructure(modelNumber);
  const range = parseCoverageRange(title);
  if (range && decoded) {
    if (decoded.capacity >= range.lo && decoded.capacity <= range.hi) {
      score += 25;
    } else {
      // Out of range: this doc covers different capacities. Strongly negative
      // so it can't accidentally win.
      score -= 100;
    }
  }

  // --- Series + suffix exact-match ---
  if (decoded) {
    const seriesLower = decoded.series.toLowerCase();
    const suffixLower = decoded.suffix.toLowerCase();
    if (seriesLower && t.includes(seriesLower) && t.includes(suffixLower)) score += 15;
    else if (suffixLower && t.includes(suffixLower)) score += 8;
  }

  // --- Direct model match (strongest signal when present) ---
  const lowerModel = modelNumber.toLowerCase();
  if (lowerModel && t.includes(lowerModel)) {
    score += 20;
  } else if (lowerModel) {
    const noPrefix = lowerModel.replace(/^[a-z]+-/, '');
    if (noPrefix !== lowerModel && t.includes(noPrefix)) score += 12;
  }

  // --- Mentions the specific part type the customer asked about ---
  if (t.includes(partType.toLowerCase())) score += 5;

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

// Words that look like part numbers but aren't — section headings,
// units, generic abbreviations from service manuals.
const PART_NUMBER_REJECTS = new Set([
  'STEP',
  'FIG',
  'FIGURE',
  'PAGE',
  'CHAPTER',
  'SECTION',
  'TABLE',
  'NOTE',
  'WARNING',
  'CAUTION',
  'MODEL',
  'TYPE',
  'PART',
  'NO',
  'REF',
  'ITEM',
  'QTY',
  'PCS',
  'UNIT',
  'AC',
  'DC',
  'VOLT',
  'AMP',
  'WATT',
  'KW',
  'HZ',
  'MHZ',
  'GHZ',
  'MM',
  'CM',
  'INCH',
  'KG',
  'IN',
  'OUT',
  'MAX',
  'MIN',
  'STD',
]);

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

    // Scan this line and the next four for a likely part-number token.
    const window = lines.slice(i, Math.min(lines.length, i + 5)).join(' ').toUpperCase();
    const matches = window.match(partTokenRe) ?? [];
    for (const candidate of matches) {
      if (!isPlausiblePartNumber(candidate, partKeywords)) continue;
      return candidate;
    }
  }
  return null;
}

// Real Panasonic part numbers tend to be 7+ chars with at least 3 digits
// (e.g. CWA73C0001, L6CBYYYL0334, CWA43C2467). They never start with a
// section-heading word like "STEP", "FIG", "PAGE".
function isPlausiblePartNumber(candidate: string, partKeywords: string[]): boolean {
  // Reject model-or-keyword-shaped tokens
  if (partKeywords.some((kw) => candidate.includes(kw))) return false;

  // Length floor
  if (candidate.length < 7) return false;

  // Must have at least 3 digits total
  const digitCount = (candidate.match(/\d/g) ?? []).length;
  if (digitCount < 3) return false;

  // Reject if the alpha prefix matches a known section/heading word
  const alphaPrefix = candidate.match(/^[A-Z]+/)?.[0] ?? '';
  if (PART_NUMBER_REJECTS.has(alphaPrefix)) return false;

  // Reject if the whole alpha part (chars before any digit/dash) looks
  // like a heading word
  const firstAlphaWord = candidate.split(/[-/.0-9]/)[0] ?? '';
  if (PART_NUMBER_REJECTS.has(firstAlphaWord)) return false;

  return true;
}

// Customer wording → parts-table entry aliases. Mirrors the lookup table
// in the playbook. Lower-case keys, upper-case parts-table phrases.
const PART_TYPE_ALIASES: Record<string, string[]> = {
  pcb: [
    'PCB ASSEMBLY',
    'PC BOARD W/COMPONENT',
    'MAIN PCB',
    'ELEC.CONTROLLER',
    'ELECTRONIC CONTROLLER',
    'PRINTED CIRCUIT',
    'PCB ASSY',
  ],
  'circuit board': ['PCB ASSEMBLY', 'PC BOARD W/COMPONENT', 'MAIN PCB', 'PRINTED CIRCUIT'],
  'main board': ['MAIN PCB', 'PC BOARD W/COMPONENT', 'PCB ASSEMBLY'],
  'control board': ['ELEC.CONTROLLER', 'ELECTRONIC CONTROLLER', 'CONTROL PCB'],
  'inverter board': ['MAIN PCB', 'INVERTER CONTROLLER', 'INVERTER PCB'],
  board: [
    'PCB ASSEMBLY',
    'PC BOARD W/COMPONENT',
    'MAIN PCB',
    'ELEC.CONTROLLER',
    'INVERTER CONTROLLER',
  ],
  'wall bracket': ['INSTALLATION PLATE', 'WALL HANG PLATE', 'BACK PLATE'],
  'mounting plate': ['INSTALLATION PLATE', 'WALL HANG PLATE'],
  'back plate': ['INSTALLATION PLATE', 'WALL HANG PLATE'],
  'condenser coil': ['CONDENSER', 'FIN & TUBE CONDENSER COMPLETE'],
  coil: ['CONDENSER', 'FIN & TUBE'],
  'fan motor': ['INDOOR FAN MOTOR', 'CROSS FLOW FAN MOTOR', 'DC MOTOR', 'FAN MOTOR'],
  fan: ['INDOOR FAN MOTOR', 'CROSS FLOW FAN MOTOR', 'DC MOTOR', 'FAN MOTOR'],
  capacitor: ['CAPACITOR'],
  compressor: ['COMPRESSOR', 'COMP.'],
  sensor: ['SENSOR', 'THERMISTOR'],
  thermistor: ['THERMISTOR', 'SENSOR'],
  remote: ['REMOTE CONTROL UNIT', 'REMOTE CONTROL'],
  filter: ['AIR FILTER', 'FILTER'],
};

function expandPartTypeKeywords(partType: string): string[] {
  const t = partType.toLowerCase().trim();
  const variants = new Set<string>([t.toUpperCase()]);
  for (const [key, aliases] of Object.entries(PART_TYPE_ALIASES)) {
    if (t === key || t.includes(key)) {
      for (const a of aliases) variants.add(a.toUpperCase());
    }
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

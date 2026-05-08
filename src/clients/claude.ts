import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';

export interface ClaudeLookupResult {
  partNumber: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface ClaudeClient {
  // Given the extracted text of a Panasonic service-manual PDF, return the
  // part number for the requested part type in the requested model. Returns
  // `partNumber: null` when Claude can't find a clear answer.
  findPartNumber(
    pdfText: string,
    modelNumber: string,
    partType: string,
  ): Promise<ClaudeLookupResult>;

  // Use Claude with the built-in web_search tool to find the part number
  // online (Panasonic support sites, parts catalogues, manualslib, etc.).
  // No need for Zunos credentials, no PDF downloads, no scraping. Returns
  // `partNumber: null` when nothing reliable can be found on the public web.
  findPartNumberByWebSearch(
    modelNumber: string,
    partType: string,
  ): Promise<ClaudeLookupResult & { source?: string }>;
}

// Fast, cheap model that's plenty smart enough for "find the row in this
// parts table that matches my question". ~$0.01-0.05 per lookup at the
// text sizes we're sending.
const MODEL = 'claude-haiku-4-5-20251001';

// We use Haiku for web search too. Sonnet is sharper at result judgement
// but its per-tier input-token rate limit is too tight on the Anthropic
// free/Tier-1 account (10k tok/min) to handle realistic web-search
// payloads. Haiku has much more headroom and is cheaper. Reasoning
// quality is fine for "is this the right Panasonic manual?" -level
// judgement.
const WEB_SEARCH_MODEL = 'claude-haiku-4-5-20251001';

// Cap how much PDF text we send. 60k chars (~15k tokens) is a comfortable
// window and keeps cost predictable; service-manual parts lists are
// typically 1-3k lines, so a smartly-sliced window covers the model fully.
const MAX_TEXT_CHARS = 60_000;

const SYSTEM_PROMPT = `You are a parts-lookup assistant for a Panasonic AC trade supplier.
Given the extracted text of a Panasonic service manual, find the exact
part number for a given part type in a given model.

CRITICAL RULES:
- Models like CS-RZ25AKR (indoor) and CU-RZ25AKR (outdoor) are different
  units with different parts. Return the part for the EXACT prefix asked.
- Multi-model manuals (e.g. RZ25-71AKR Service Manual) have separate
  parts tables per capacity. Find the table for the EXACT model asked
  (e.g. CU-RZ25AKR specifically, not CU-RZ35AKR or CU-RZ71AKR).
- Skip table-of-contents entries (lines with many dots followed by a page
  number). Look in the actual parts table at the END of the manual.
- "PCB" / "circuit board" / "main board" / "control board" are commonly
  written in Panasonic parts tables as "ELECTRONIC CONTROLLER" (often
  with a "- MAIN" or "- DM" suffix), "MAIN PCB", "PC BOARD W/COMPONENT",
  or "PCB ASSEMBLY". The user may have asked for a different wording.
- Real Panasonic part numbers look like ACXA73C74200R, CWA73C0001,
  L6CBYYYL0334, ACXD52K01770. Do NOT return things like "STEP-1",
  "FIG-3", or row reference numbers — those are document structure,
  not parts.

CONFIDENCE:
- "high": clear single match in the right model's parts table.
- "medium": found a plausible match but had to use judgement (e.g.
  ambiguous part type with multiple candidates, picked the most likely).
- "low": guessed, or the relevant table doesn't appear to be in the
  text. Prefer returning partNumber=null with confidence "low" over
  guessing.

OUTPUT — return ONLY a JSON object, no preamble or markdown:
{
  "partNumber": "ACXA74C08350R" | null,
  "confidence": "high" | "medium" | "low",
  "reasoning": "Found in CU-RZ25AKR section, row 38 'ELECTRONIC CONTROLLER - MAIN'"
}`;

const WEB_SEARCH_SYSTEM_PROMPT = `You are a parts-lookup assistant for a Panasonic AC trade
supplier. Use the web_search tool to find the official Panasonic part number for a given
part type in a given model.

SEARCH STRATEGY:
1. Search for the model number plus "service manual" or "parts list" or "spare parts".
2. Prefer official sources: panasonic.com, panasonic.com.au, dealer portals,
   well-indexed service-manual archives (manualslib, manualsonline, etc.).
3. If the first search doesn't yield clear results, try variations:
   model number with and without prefix (e.g. "RZ25AKR" instead of "CU-RZ25AKR"),
   "[model] PCB part number", or part-list-specific phrasing.
4. Don't trust forum posts, eBay listings, or after-market parts vendors as
   primary sources — they're often wrong about which part fits which model.

CRITICAL RULES (same as for PDF reading):
- Models like CS-RZ25AKR (indoor) and CU-RZ25AKR (outdoor) are different
  units with different parts. Return the part for the EXACT prefix asked.
- Multi-model manuals have separate parts tables per capacity. CU-RZ25AKR
  and CU-RZ71AKR have different parts even within the same manual.
- "PCB" / "circuit board" / "main board" is commonly written in Panasonic
  parts tables as "ELECTRONIC CONTROLLER" (often with a "- MAIN" or "- DM"
  suffix), "MAIN PCB", "PC BOARD W/COMPONENT", or "PCB ASSEMBLY".
- Real Panasonic part numbers look like ACXA73C74200R, CWA73C0001,
  L6CBYYYL0334, ACXD52K01770. Do NOT return things like "STEP-1",
  "FIG-3", or row reference numbers.

CONFIDENCE:
- "high": found a clear match in an authoritative source (Panasonic site,
  official service manual). Source URL clearly identifies the right model.
- "medium": found a plausible match but had to make a judgement call
  (parts vendor without official manual, or close-match model variant).
- "low": couldn't find a clear answer. Prefer returning partNumber=null
  with confidence "low" over guessing.

OUTPUT — return ONLY a JSON object, no preamble or markdown:
{
  "partNumber": "ACXA74C08350R" | null,
  "confidence": "high" | "medium" | "low",
  "reasoning": "Found in Panasonic CU-RZ25AKR Service Manual at <source>",
  "source": "https://example.com/path/to/manual.pdf"
}`;

export function createClaudeClient(cfg: Config): ClaudeClient {
  if (!cfg.anthropicApiKey) {
    return {
      async findPartNumber() {
        console.error(
          '[claude] ANTHROPIC_API_KEY not set; Claude lookup disabled. ' +
            'Falling back to regex extraction.',
        );
        return { partNumber: null, confidence: 'low', reasoning: 'Claude API not configured' };
      },
      async findPartNumberByWebSearch() {
        console.error(
          '[claude] ANTHROPIC_API_KEY not set; web-search lookup disabled.',
        );
        return { partNumber: null, confidence: 'low', reasoning: 'Claude API not configured' };
      },
    };
  }

  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  return {
    async findPartNumber(pdfText, modelNumber, partType) {
      const sliced = sliceTextAroundModel(pdfText, modelNumber, MAX_TEXT_CHARS);
      console.error(
        `[claude] sending ${sliced.length} chars of PDF text for "${partType}" in "${modelNumber}"`,
      );

      let response;
      try {
        response = await client.messages.create({
          model: MODEL,
          max_tokens: 512,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: `Find the ${partType} part number for model ${modelNumber} in this PDF text.

<pdf_text>
${sliced}
</pdf_text>

Return only the JSON object — no markdown, no preamble.`,
            },
          ],
        });
      } catch (err) {
        console.error('[claude] API call failed:', err);
        return {
          partNumber: null,
          confidence: 'low',
          reasoning: `Claude API error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const replyText = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim();

      try {
        const cleaned = stripMarkdownFence(replyText);
        const parsed = JSON.parse(cleaned) as {
          partNumber: string | null;
          confidence?: 'high' | 'medium' | 'low';
          reasoning?: string;
        };
        return {
          partNumber: parsed.partNumber ?? null,
          confidence: parsed.confidence ?? 'low',
          reasoning: parsed.reasoning ?? '',
        };
      } catch {
        console.error(`[claude] could not parse response as JSON: ${replyText}`);
        return {
          partNumber: null,
          confidence: 'low',
          reasoning: `Could not parse Claude response: ${replyText.slice(0, 200)}`,
        };
      }
    },

    async findPartNumberByWebSearch(modelNumber, partType) {
      console.error(
        `[claude] web search for "${partType}" in "${modelNumber}"`,
      );

      let response;
      try {
        // The web_search tool's TypeScript types weren't yet exposed in
        // @anthropic-ai/sdk 0.30. The HTTP API accepts it; we cast the
        // tools array to satisfy the compiler.
        const tools = [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5,
          },
        ] as unknown as Anthropic.Messages.Tool[];
        response = await client.messages.create({
          model: WEB_SEARCH_MODEL,
          max_tokens: 1500,
          tools,
          system: WEB_SEARCH_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content:
                `Find the official Panasonic part number for the ${partType} ` +
                `in model ${modelNumber}. Search the web for service manuals, ` +
                `parts catalogues, or dealer documents that show this model's ` +
                `parts list. Return only the JSON object described in your ` +
                `instructions — no markdown, no preamble.`,
            },
          ],
        });
      } catch (err) {
        console.error('[claude] web-search API call failed:', err);
        return {
          partNumber: null,
          confidence: 'low',
          reasoning: `Claude API error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const replyText = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim();

      try {
        const cleaned = stripMarkdownFence(replyText);
        const parsed = JSON.parse(cleaned) as {
          partNumber: string | null;
          confidence?: 'high' | 'medium' | 'low';
          reasoning?: string;
          source?: string;
        };
        return {
          partNumber: parsed.partNumber ?? null,
          confidence: parsed.confidence ?? 'low',
          reasoning: parsed.reasoning ?? '',
          source: parsed.source,
        };
      } catch {
        console.error(`[claude] could not parse web-search response: ${replyText}`);
        return {
          partNumber: null,
          confidence: 'low',
          reasoning: `Could not parse Claude response: ${replyText.slice(0, 200)}`,
        };
      }
    },
  };
}

// Take a window of the PDF text around the most relevant occurrence of
// the model number. If the model isn't found, fall back to the last
// portion of the document (where service-manual parts lists usually live).
export function sliceTextAroundModel(
  text: string,
  modelNumber: string,
  maxChars: number,
): string {
  if (text.length <= maxChars) return text;

  const lines = text.split(/\r?\n/);
  const target = modelNumber.toUpperCase();

  // Find non-TOC occurrences of the model number
  const occurrences: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.toUpperCase().includes(target) && !/\.{5,}/.test(line)) {
      occurrences.push(i);
    }
  }

  if (occurrences.length === 0) {
    // Fall back to the last 25% of the document (parts list is typically
    // at the end of service manuals).
    const sliceFrom = Math.max(0, text.length - maxChars);
    return text.slice(sliceFrom);
  }

  // Centre the window on the LATEST non-TOC occurrence — service manuals
  // mention each model multiple times (specs, wiring, parts) and the parts
  // table is the last one.
  const center = occurrences[occurrences.length - 1]!;
  let chars = lines[center]!.length + 1;
  let start = center;
  let end = center;

  while ((start > 0 || end < lines.length - 1) && chars < maxChars) {
    if (end < lines.length - 1) {
      end++;
      chars += lines[end]!.length + 1;
      if (chars >= maxChars) break;
    }
    if (start > 0) {
      start--;
      chars += lines[start]!.length + 1;
    }
  }

  return lines.slice(start, end + 1).join('\n');
}

function stripMarkdownFence(s: string): string {
  // Claude often wraps the JSON in ```json ... ``` and may include prose
  // before/after the fence. Try, in order:
  //   1. extract the JSON inside a ```json fenced block
  //   2. extract the JSON inside any ``` fenced block
  //   3. fall back to the last { ... } object in the reply
  //   4. give back the raw string and let the caller's JSON.parse fail
  const fenced =
    /```json\s*([\s\S]*?)\s*```/i.exec(s) ?? /```\s*([\s\S]*?)\s*```/.exec(s);
  if (fenced) return fenced[1]!.trim();

  // Greedy match for the largest { ... } in the reply (handles nested braces).
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return s.slice(firstBrace, lastBrace + 1).trim();
  }

  return s.trim();
}

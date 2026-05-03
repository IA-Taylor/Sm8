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
}

// Fast, cheap model that's plenty smart enough for "find the row in this
// parts table that matches my question". ~$0.01-0.05 per lookup at the
// text sizes we're sending.
const MODEL = 'claude-haiku-4-5-20251001';

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
  // Claude sometimes wraps JSON in ```json ... ``` despite being told not to.
  return s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

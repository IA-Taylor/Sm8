import type { ClassifiedNote } from './types.js';

// The bot only responds when addressed by name. The note must start with
// "Kevin" (optional comma, colon, or whitespace separator) followed by the
// command. Anything else is ignored, so the bot doesn't react to every
// random job note.
export const BOT_NAME = 'Kevin';

const KEVIN_PREFIX_RE = /^\s*kevin[\s,:]+/i;

// Direct part order: Kevin order <part> [qty]
const QUOTE_RE = /^order\s+(?<part>[A-Za-z0-9._/-]+)(?:\s+(?<qty>\d+))?\s*$/i;

// Order confirmation
const ORDER_RE = /^yes,?\s+please\s+order\s+this\s+part\s+on\s+epan\s*$/i;

// Natural-language model lookup: "find a PCB for a CU-RZ25AKR",
// "can you get a fan motor for CS-RE15RKR 2", etc.
const PART_TYPE_KEYWORDS = [
  'pcb',
  'circuit board',
  'main board',
  'control board',
  'control pcb',
  'fan motor',
  'fan',
  'motor',
  'capacitor',
  'compressor',
  'sensor',
  'thermistor',
  'relay',
  'valve',
  'filter',
  'pump',
];

const MODEL_NUMBER_RE = /\b([A-Z][A-Z0-9]*(?:[-/.][A-Z0-9]+){1,})\b/i;

export function classifyNote(body: string): ClassifiedNote {
  if (!body) return { kind: 'ignore' };
  const trimmed = body.trim();

  const kevinMatch = KEVIN_PREFIX_RE.exec(trimmed);
  if (!kevinMatch) return { kind: 'ignore' };

  const remainder = trimmed.slice(kevinMatch[0].length).trim();

  if (ORDER_RE.test(remainder)) {
    return { kind: 'order' };
  }

  const directQuote = QUOTE_RE.exec(remainder);
  if (directQuote?.groups?.part) {
    const qty = directQuote.groups.qty ? parseInt(directQuote.groups.qty, 10) : 1;
    return { kind: 'quote', partNumber: directQuote.groups.part, qty };
  }

  // Natural-language model lookup. Look for both a part-type keyword and
  // a model-number-shaped token in the same sentence.
  const lower = remainder.toLowerCase();
  const partType = PART_TYPE_KEYWORDS.find((kw) => lower.includes(kw));
  const modelMatch = MODEL_NUMBER_RE.exec(remainder);
  if (partType && modelMatch) {
    const qty = extractQty(remainder);
    return {
      kind: 'lookup',
      modelNumber: modelMatch[1]!.toUpperCase(),
      partType: normalisePartType(partType),
      qty,
    };
  }

  return { kind: 'ignore' };
}

function extractQty(text: string): number {
  // Look for "qty 3" / "x 3" / "3 of" / standalone trailing digit.
  const explicit = /\b(?:qty|x|×)\s*(\d+)/i.exec(text);
  if (explicit) return parseInt(explicit[1]!, 10);
  const trailing = /\s(\d{1,3})\s*$/.exec(text);
  if (trailing) return parseInt(trailing[1]!, 10);
  return 1;
}

function normalisePartType(raw: string): string {
  const t = raw.toLowerCase();
  if (t === 'circuit board' || t === 'main board' || t === 'control board' || t === 'control pcb') {
    return 'PCB';
  }
  if (t === 'fan' || t === 'motor') return 'fan motor';
  return t;
}

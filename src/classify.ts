import type { ClassifiedNote } from './types.js';

// The bot only responds when addressed by name. The note must start with
// "Kevin" (optional comma, colon, or whitespace separator) followed by the
// command. Anything else is ignored, so the bot doesn't react to every
// random job note.
export const BOT_NAME = 'Kevin';

const KEVIN_PREFIX_RE = /^\s*kevin[\s,:]+/i;
const QUOTE_RE = /^order\s+(?<part>[A-Za-z0-9._/-]+)(?:\s+(?<qty>\d+))?\s*$/i;
const ORDER_RE = /^yes,?\s+please\s+order\s+this\s+part\s+on\s+epan\s*$/i;

export function classifyNote(body: string): ClassifiedNote {
  if (!body) return { kind: 'ignore' };
  const trimmed = body.trim();

  const kevinMatch = KEVIN_PREFIX_RE.exec(trimmed);
  if (!kevinMatch) return { kind: 'ignore' };

  const remainder = trimmed.slice(kevinMatch[0].length).trim();

  if (ORDER_RE.test(remainder)) {
    return { kind: 'order' };
  }

  const m = QUOTE_RE.exec(remainder);
  if (m?.groups?.part) {
    const qty = m.groups.qty ? parseInt(m.groups.qty, 10) : 1;
    return { kind: 'quote', partNumber: m.groups.part, qty };
  }

  return { kind: 'ignore' };
}

import type { ClassifiedNote } from './types.js';

const QUOTE_RE = /^\s*order\s+(?<part>[A-Za-z0-9._/-]+)(?:\s+(?<qty>\d+))?\s*$/i;
const ORDER_RE = /yes,?\s+please\s+order\s+this\s+part\s+on\s+epan/i;

export function classifyNote(body: string): ClassifiedNote {
  if (!body) return { kind: 'ignore' };
  const trimmed = body.trim();

  if (ORDER_RE.test(trimmed)) {
    return { kind: 'order' };
  }

  const m = QUOTE_RE.exec(trimmed);
  if (m?.groups?.part) {
    const qty = m.groups.qty ? parseInt(m.groups.qty, 10) : 1;
    return { kind: 'quote', partNumber: m.groups.part, qty };
  }

  return { kind: 'ignore' };
}

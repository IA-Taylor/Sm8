import { describe, expect, it } from 'vitest';
import { classifyNote } from '../src/classify.js';

describe('classifyNote', () => {
  it('parses an order quote with default qty', () => {
    expect(classifyNote('order ABC-123')).toEqual({
      kind: 'quote',
      partNumber: 'ABC-123',
      qty: 1,
    });
  });

  it('parses an order quote with explicit qty', () => {
    expect(classifyNote('order  XYZ.99   5')).toEqual({
      kind: 'quote',
      partNumber: 'XYZ.99',
      qty: 5,
    });
  });

  it('is case-insensitive on the order keyword', () => {
    expect(classifyNote('ORDER abc')).toEqual({ kind: 'quote', partNumber: 'abc', qty: 1 });
  });

  it('detects the order-confirmation phrase', () => {
    expect(classifyNote('Yes, please order this part on EPAN')).toEqual({ kind: 'order' });
    expect(classifyNote('  yes please   order  this  part on epan  ')).toEqual({ kind: 'order' });
  });

  it('ignores unrelated notes', () => {
    expect(classifyNote('arrived on site')).toEqual({ kind: 'ignore' });
    expect(classifyNote('order')).toEqual({ kind: 'ignore' });
    expect(classifyNote('')).toEqual({ kind: 'ignore' });
  });

  it('does not double-match an order-confirmation as a quote', () => {
    expect(classifyNote('yes please order this part on epan')).toEqual({ kind: 'order' });
  });
});

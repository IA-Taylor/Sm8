import { describe, expect, it } from 'vitest';
import { classifyNote } from '../src/classify.js';

describe('classifyNote', () => {
  it('parses a quote when addressed by name', () => {
    expect(classifyNote('Kevin order ABC-123')).toEqual({
      kind: 'quote',
      partNumber: 'ABC-123',
      qty: 1,
    });
  });

  it('accepts comma and colon separators after the name', () => {
    expect(classifyNote('Kevin, order ABC-123')).toEqual({
      kind: 'quote',
      partNumber: 'ABC-123',
      qty: 1,
    });
    expect(classifyNote('Kevin: order ABC-123 5')).toEqual({
      kind: 'quote',
      partNumber: 'ABC-123',
      qty: 5,
    });
  });

  it('is case-insensitive on both the name and the keyword', () => {
    expect(classifyNote('kevin ORDER abc')).toEqual({
      kind: 'quote',
      partNumber: 'abc',
      qty: 1,
    });
    expect(classifyNote('KEVIN order ABC')).toEqual({
      kind: 'quote',
      partNumber: 'ABC',
      qty: 1,
    });
  });

  it('parses an order quote with explicit qty', () => {
    expect(classifyNote('Kevin order  XYZ.99   5')).toEqual({
      kind: 'quote',
      partNumber: 'XYZ.99',
      qty: 5,
    });
  });

  it('detects the order-confirmation phrase when addressed', () => {
    expect(classifyNote('Kevin Yes, please order this part on EPAN')).toEqual({ kind: 'order' });
    expect(classifyNote('Kevin yes please   order  this  part on epan')).toEqual({
      kind: 'order',
    });
  });

  it('ignores notes that do not address Kevin', () => {
    expect(classifyNote('order ABC-123')).toEqual({ kind: 'ignore' });
    expect(classifyNote('yes please order this part on EPAN')).toEqual({ kind: 'ignore' });
    expect(classifyNote('arrived on site')).toEqual({ kind: 'ignore' });
    expect(classifyNote('Hey Kevin, can you order ABC-123')).toEqual({ kind: 'ignore' });
    expect(classifyNote('')).toEqual({ kind: 'ignore' });
  });

  it('ignores Kevin with no recognised command', () => {
    expect(classifyNote('Kevin')).toEqual({ kind: 'ignore' });
    expect(classifyNote('Kevin hi there')).toEqual({ kind: 'ignore' });
    expect(classifyNote('Kevin order')).toEqual({ kind: 'ignore' });
  });
});

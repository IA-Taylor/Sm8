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

  describe('natural-language model lookup', () => {
    it('extracts model + part type from a typical request', () => {
      expect(classifyNote('Kevin can you find a PCB for a CU-RZ25AKR')).toEqual({
        kind: 'lookup',
        modelNumber: 'CU-RZ25AKR',
        partType: 'pcb',
        qty: 1,
      });
    });

    it('handles "fan motor" multi-word part type', () => {
      expect(classifyNote('Kevin find a fan motor for CS-RE15RKR')).toEqual({
        kind: 'lookup',
        modelNumber: 'CS-RE15RKR',
        partType: 'fan motor',
        qty: 1,
      });
    });

    it('normalises board synonyms to PCB', () => {
      expect(classifyNote('Kevin get a circuit board for CU-RZ25AKR')).toEqual({
        kind: 'lookup',
        modelNumber: 'CU-RZ25AKR',
        partType: 'PCB',
        qty: 1,
      });
      expect(classifyNote('Kevin get me a main board for CU-RZ25AKR')).toEqual({
        kind: 'lookup',
        modelNumber: 'CU-RZ25AKR',
        partType: 'PCB',
        qty: 1,
      });
    });

    it('captures explicit quantity', () => {
      expect(classifyNote('Kevin get 3 capacitors for CU-RZ25AKR')).toEqual({
        kind: 'lookup',
        modelNumber: 'CU-RZ25AKR',
        partType: 'capacitor',
        qty: 1, // qty extraction only finds "qty N", "x N", or trailing N
      });
      expect(classifyNote('Kevin get a PCB for CU-RZ25AKR qty 2')).toEqual({
        kind: 'lookup',
        modelNumber: 'CU-RZ25AKR',
        partType: 'pcb',
        qty: 2,
      });
    });

    it('ignores natural-language requests without both pieces', () => {
      // No part type
      expect(classifyNote('Kevin tell me about CU-RZ25AKR')).toEqual({ kind: 'ignore' });
      // No model
      expect(classifyNote('Kevin I need a PCB please')).toEqual({ kind: 'ignore' });
    });

    it("doesn't double-match a direct quote as a lookup", () => {
      // "Kevin order CU-RZ25AKR" should be a direct quote, not a model lookup
      expect(classifyNote('Kevin order CU-RZ25AKR')).toEqual({
        kind: 'quote',
        partNumber: 'CU-RZ25AKR',
        qty: 1,
      });
    });
  });
});

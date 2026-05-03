import { describe, expect, it } from 'vitest';
import {
  buildSearchTiers,
  decodeModelStructure,
  parseCoverageRange,
  scorePdfTitle,
  titleMentionsModel,
} from '../src/clients/zunos.js';

describe('decodeModelStructure', () => {
  it('decodes RAC indoor', () => {
    expect(decodeModelStructure('CS-RZ50TKR')).toEqual({
      prefix: 'CS',
      series: 'RZ',
      capacity: 50,
      suffix: 'TKR',
    });
  });

  it('decodes RAC outdoor', () => {
    expect(decodeModelStructure('CU-RZ25AKR')).toEqual({
      prefix: 'CU',
      series: 'RZ',
      capacity: 25,
      suffix: 'AKR',
    });
  });

  it('decodes PAC indoor without internal series', () => {
    const r = decodeModelStructure('S-160PE1R5A');
    expect(r?.prefix).toBe('S');
    expect(r?.capacity).toBe(160);
    expect(r?.suffix).toBe('PE1R5A');
  });

  it('returns null for malformed model strings', () => {
    expect(decodeModelStructure('not a model')).toBeNull();
    expect(decodeModelStructure('123')).toBeNull();
  });
});

describe('parseCoverageRange', () => {
  it('finds the lo-hi pair in service-manual titles', () => {
    expect(parseCoverageRange('S-60-140PE1R5A Service Manual')).toEqual({ lo: 60, hi: 140 });
    expect(parseCoverageRange('S-60-160PE1R5A Exploded View & Parts List')).toEqual({
      lo: 60,
      hi: 160,
    });
    expect(parseCoverageRange('RZ25-80TKR Service Manual')).toEqual({ lo: 25, hi: 80 });
    expect(parseCoverageRange('U71-80XKR Service Manual')).toEqual({ lo: 71, hi: 80 });
    expect(parseCoverageRange('U-160-224PE2R8A Exploded Views & Parts List')).toEqual({
      lo: 160,
      hi: 224,
    });
  });

  it('returns null when no range is present', () => {
    expect(parseCoverageRange('CU-RZ25AKR Service Manual')).toBeNull();
    expect(parseCoverageRange('Operating Instructions')).toBeNull();
  });
});

describe('buildSearchTiers', () => {
  it('produces full, no-prefix, and family tiers', () => {
    expect(buildSearchTiers('CU-RZ25AKR')).toEqual(['CU-RZ25AKR', 'RZ25AKR', 'RZ AKR']);
  });

  it('handles model strings without an internal series', () => {
    expect(buildSearchTiers('S-160PE1R5A')).toEqual(['S-160PE1R5A', '160PE1R5A', ' PE1R5A']);
  });
});

describe('titleMentionsModel', () => {
  it('accepts the full model code in the title', () => {
    expect(titleMentionsModel('CU-RZ25AKR Service Manual', 'CU-RZ25AKR')).toBe(true);
  });

  it('accepts the model-core (no prefix) in the title', () => {
    expect(titleMentionsModel('RZ25AKR Exploded View & Parts List', 'CU-RZ25AKR')).toBe(true);
  });

  it('accepts a coverage-range title with matching suffix', () => {
    expect(titleMentionsModel('RZ25-80TKR Service Manual', 'CS-RZ50TKR')).toBe(true);
    expect(titleMentionsModel('S-60-160PE1R5A Service Manual', 'S-100PE1R5A')).toBe(true);
  });

  it('rejects coverage-range titles whose range excludes the target capacity', () => {
    expect(titleMentionsModel('S-60-140PE1R5A Service Manual', 'S-160PE1R5A')).toBe(false);
  });

  it('rejects coverage-range titles whose suffix does not match', () => {
    expect(titleMentionsModel('RZ25-80TKR Service Manual', 'CS-RZ50AKR')).toBe(false);
  });

  it('rejects unrelated titles entirely', () => {
    expect(titleMentionsModel('Some Other Product Brochure', 'CU-RZ25AKR')).toBe(false);
    expect(titleMentionsModel('Generic Service Manual', 'CU-RZ25AKR')).toBe(false);
  });
});

describe('scorePdfTitle', () => {
  it('strongly prefers Exploded View & Parts List that covers the target capacity', () => {
    const ep = scorePdfTitle(
      'S-60-160PE1R5A Exploded View & Parts List',
      'PCB',
      'S-160PE1R5A',
    );
    const sm = scorePdfTitle('S-60-160PE1R5A Service Manual', 'PCB', 'S-160PE1R5A');
    expect(ep).toBeGreaterThan(sm);
  });

  it('strongly penalises a doc whose coverage range does not include the target', () => {
    const inRange = scorePdfTitle(
      'S-60-160PE1R5A Service Manual',
      'PCB',
      'S-160PE1R5A',
    );
    const outOfRange = scorePdfTitle(
      'S-60-140PE1R5A Service Manual',
      'PCB',
      'S-160PE1R5A',
    );
    expect(outOfRange).toBeLessThan(inRange);
    expect(outOfRange).toBeLessThan(0); // explicitly negative — should be unpickable
  });

  it('penalises Operating Instructions and Brochures', () => {
    expect(scorePdfTitle('CU-RZ25AKR Operating Instructions', 'PCB', 'CU-RZ25AKR')).toBeLessThan(
      scorePdfTitle('CU-RZ25AKR Service Manual', 'PCB', 'CU-RZ25AKR'),
    );
  });

  it('boosts a doc that mentions the customer\'s part type', () => {
    const withType = scorePdfTitle('CU-RZ25AKR PCB Assembly Reference', 'PCB', 'CU-RZ25AKR');
    const withoutType = scorePdfTitle(
      'CU-RZ25AKR Maintenance Reference',
      'PCB',
      'CU-RZ25AKR',
    );
    expect(withType).toBeGreaterThan(withoutType);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildSearchTiers,
  decodeModelStructure,
  findPartNumberInText,
  hasConflictingPrefix,
  parseCoverageRange,
  scopeToModelSection,
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

  it('rejects coverage-range titles whose series does not match', () => {
    // Z20-71AKR is the Z series; CU-RZ25AKR is the RZ series. Different
    // product families even though the suffix and capacity look similar.
    expect(titleMentionsModel('Z20-71AKR Service Manual', 'CU-RZ25AKR')).toBe(false);
    expect(titleMentionsModel('U25-80AKR Service Manual', 'CU-RZ25AKR')).toBe(false);
    // But the right series is accepted
    expect(titleMentionsModel('RZ25-71AKR Service Manual', 'CU-RZ25AKR')).toBe(true);
  });

  it('rejects unrelated titles entirely', () => {
    expect(titleMentionsModel('Some Other Product Brochure', 'CU-RZ25AKR')).toBe(false);
    expect(titleMentionsModel('Generic Service Manual', 'CU-RZ25AKR')).toBe(false);
  });

  it('rejects indoor pair when asked for outdoor (and vice versa)', () => {
    // CS = indoor, CU = outdoor. Same model core, different units.
    expect(titleMentionsModel('CS-RZ25AKR Service Manual', 'CU-RZ25AKR')).toBe(false);
    expect(titleMentionsModel('CU-RZ25AKR Service Manual', 'CS-RZ25AKR')).toBe(false);
    // S = PAC indoor, U = PAC outdoor
    expect(titleMentionsModel('U-160PE2R8A Exploded View', 'S-160PE1R5A')).toBe(false);
  });

  it('accepts a combined manual that lists both indoor and outdoor pair', () => {
    expect(
      titleMentionsModel('CS-RZ25AKR / CU-RZ25AKR Service Manual', 'CU-RZ25AKR'),
    ).toBe(true);
  });

  it('accepts a prefix-less title even when the model has a prefix', () => {
    // Some Panasonic docs drop the CS-/CU- prefix in titles entirely.
    expect(titleMentionsModel('RZ25-80TKR Service Manual', 'CS-RZ50TKR')).toBe(true);
  });
});

describe('scopeToModelSection + findPartNumberInText', () => {
  const combinedManual = `
INDOOR UNIT PARTS LIST
CS-RZ25AKR

REF NO.   PART NAME              PART NUMBER
1         PCB ASSEMBLY           CWA73C0001
2         FAN MOTOR              CWA98F1234
3         CAPACITOR              CWA77B5555

OUTDOOR UNIT PARTS LIST
CU-RZ25AKR

REF NO.   PART NAME              PART NUMBER
1         PCB ASSEMBLY           CWA73D2222
2         FAN MOTOR              CWA98F5555
3         COMPRESSOR             CWA12C9999
`;

  it('scopes to the OUTDOOR section when asked about CU- model', () => {
    const scoped = scopeToModelSection(combinedManual, 'CU-RZ25AKR');
    expect(scoped).toBeTruthy();
    expect(scoped).toContain('CU-RZ25AKR');
    expect(scoped).toContain('CWA73D2222'); // outdoor PCB
    expect(scoped).not.toContain('CWA73C0001'); // indoor PCB excluded
  });

  it('scopes to the INDOOR section when asked about CS- model', () => {
    const scoped = scopeToModelSection(combinedManual, 'CS-RZ25AKR');
    expect(scoped).toBeTruthy();
    expect(scoped).toContain('CS-RZ25AKR');
    expect(scoped).toContain('CWA73C0001'); // indoor PCB
    // The scoped slice ends at the OUTDOOR header so the outdoor PCB
    // shouldn't be in scope.
    expect(scoped).not.toContain('CWA73D2222');
  });

  it('returns the OUTDOOR PCB part number when extracting from the combined manual', () => {
    expect(findPartNumberInText(combinedManual, 'PCB', 'CU-RZ25AKR')).toBe('CWA73D2222');
  });

  it('returns the INDOOR PCB part number when extracting for CS-', () => {
    expect(findPartNumberInText(combinedManual, 'PCB', 'CS-RZ25AKR')).toBe('CWA73C0001');
  });

  it('returns null when no model is given and falls back to whole-doc scan', () => {
    // Without scoping, returns the first PCB in the document
    expect(findPartNumberInText(combinedManual, 'PCB')).toBe('CWA73C0001');
  });
});

describe('hasConflictingPrefix', () => {
  it('detects a different prefix without ours present', () => {
    expect(hasConflictingPrefix('CS-RZ25AKR Service Manual', 'CU')).toBe(true);
    expect(hasConflictingPrefix('U-160PE2R8A Exploded View', 'S')).toBe(true);
  });

  it('passes when ours is also present', () => {
    expect(hasConflictingPrefix('CS-RZ25AKR / CU-RZ25AKR Service Manual', 'CU')).toBe(false);
  });

  it('passes when no prefix is in the title at all', () => {
    expect(hasConflictingPrefix('RZ25-80TKR Service Manual', 'CU')).toBe(false);
  });

  it('passes when our prefix matches', () => {
    expect(hasConflictingPrefix('CU-RZ25AKR Service Manual', 'CU')).toBe(false);
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

  it('treats common typos of "Service Manual" as a service manual', () => {
    expect(scorePdfTitle('RZ25-71AKR Service Manul', 'PCB', 'CU-RZ25AKR')).toBeGreaterThan(
      scorePdfTitle('CU-RZ25-95AKR Installation Instructions', 'PCB', 'CU-RZ25AKR'),
    );
    expect(scorePdfTitle('RZ25-71AKR Service Manuel', 'PCB', 'CU-RZ25AKR')).toBeGreaterThan(
      scorePdfTitle('CU-RZ25-95AKR Installation Instructions', 'PCB', 'CU-RZ25AKR'),
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

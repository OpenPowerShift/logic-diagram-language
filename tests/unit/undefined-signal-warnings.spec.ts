import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { EXAMPLES } from '../../src/examples.js';

// #32: a name referenced but never assigned silently becomes a boundary input. That is legal (real
// external signals), so we do NOT warn on every bare input — only on likely TYPOS: an undefined
// reference that is a near-miss of a name the author did define/declare.
const warnNames = (src: string) => parse(src).warnings.map(w => /Signal '([^']+)'/.exec(w.message)![1]);

describe('undefined-signal typo warnings (#32)', () => {
  it('warns on a one-edit typo of a defined signal, with a suggestion', () => {
    const { warnings } = parse(`RESET = A\nO = REST AND B`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain(`Signal 'REST'`);
    expect(warnings[0].message).toContain(`did you mean 'RESET'`);
  });

  it('allows a two-edit typo only for long names', () => {
    expect(warnNames(`OVERCURRENT = A OR B\nT = OVERCURENT AND C`)).toEqual(['OVERCURENT']); // len 10, dist 1
    // A two-edit slip on a long name is still a typo…
    expect(warnNames(`OVERCURRENT = A OR B\nT = OVERCURNT AND C`)).toEqual(['OVERCURNT']);   // len 9, dist 2
    // …but a two-edit gap on a short name is treated as a distinct signal, not a typo.
    expect(warnNames(`HALT = A\nT = HELP AND B`)).toEqual([]);                                // HELP vs HALT, len 4, dist 2
  });

  it('does not warn on genuine distinct inputs', () => {
    expect(warnNames(`O = A AND B`)).toEqual([]);
    expect(warnNames(`TRIP = OVERCURRENT OR EARTHFAULT OR MANUALTRIP`)).toEqual([]);
  });

  it('does not warn on short pin-style names near an output (A, B, IA, A1)', () => {
    // Single/near-single-char names sit within one edit of each other and of a short output — excluded.
    expect(warnNames(`O = IA AND A1 AND C`)).toEqual([]);
    expect(warnNames(`AB = X AND Y\nO = AB AND AC`)).toEqual([]); // AC vs AB len 2 → below the typo-length floor
  });

  it('does not warn on a signal that IS assigned, incl. feedback self-reference', () => {
    expect(warnNames(`ALARM = A OR B\nO = ALARM AND C`)).toEqual([]);          // ALARM defined → referenced cleanly
    expect(warnNames(`Q = SET OR (Q AND NOT RESET)`)).toEqual([]);             // Q self-ref (feedback), not a typo
  });

  it('carries the reference position', () => {
    const { warnings } = parse(`RESET = A\nO = REST AND B`);
    expect(warnings[0].line).toBe(2);                                          // the REST reference is on line 2
  });

  it('is silent on every bundled example (no false positives on real content)', () => {
    for (const [name, src] of Object.entries(EXAMPLES)) {
      expect(parse(src).warnings, `${name} should not emit typo warnings`).toEqual([]);
    }
  });

  it('always exposes a warnings array, even on lex error', () => {
    expect(Array.isArray(parse(`O = A AND B`).warnings)).toBe(true);
    expect(Array.isArray(parse(`O = "unterminated`).warnings)).toBe(true);
  });
});

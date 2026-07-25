import { describe, it, expect } from 'vitest';
import { layoutDiagram, findWireCrossings } from '../../src/renderer/layout.js';
import { parse } from '../../src/parser/index.js';
import { resolveOptions } from '../../src/parser/ast.js';

// #37: OPTION FANOUT_CONNECTORS draws a very-high-fan-out, wide-span net as off-page connector stubs
// instead of one snaking wire. It's a scored candidate axis (like lane packing): tried with AND
// without, the best kept on the full lexicographic score — so it de-tangles diagrams it helps and
// never regresses one it doesn't. Default OFF (opt-in), so the corpus is untouched.
describe('FANOUT_CONNECTORS (off-page fan-out, #37)', () => {
  // A global inhibit (`INH`) consumed by many outputs down the page — one wire crosses everything.
  const inhibit = ['INH = GA AND GB', ...Array.from({ length: 6 }, (_, i) => `O${i} = IN${i} AND NOT INH`)].join('\n');
  const cross = (src: string) => { const r = parse(src); const l = layoutDiagram(r.diagram, resolveOptions(r.diagram.options)); return { l, n: findWireCrossings(l.wires, l.junctions).length }; };

  it('is off by default (no connector tags)', () => {
    expect(cross(inhibit).l.labels.some(x => x.connector)).toBe(false);
  });

  it('connectorises a genuinely-crossing global inhibit: tags + fewer crossings', { timeout: 20000 }, () => {
    const off = cross(inhibit);
    const on = cross('OPTION FANOUT_CONNECTORS = TRUE\n' + inhibit);
    const tags = on.l.labels.filter(x => x.connector);
    expect(tags.filter(x => x.connector === 'source').length).toBe(1);       // one source tag
    expect(tags.filter(x => x.connector === 'sink').length).toBeGreaterThanOrEqual(4); // one per consumer
    expect(on.n).toBeLessThan(off.n);                                        // crossings genuinely drop
  });

  it('leaves a well-routed net alone (no forced connectorisation)', () => {
    // A tiny diagram where the net neither spans nor crosses — connectors must not be applied.
    const small = 'X = A AND B\nO1 = X AND C\nO2 = X OR D';
    expect(cross('OPTION FANOUT_CONNECTORS = TRUE\n' + small).l.labels.some(x => x.connector)).toBe(false);
  });
});

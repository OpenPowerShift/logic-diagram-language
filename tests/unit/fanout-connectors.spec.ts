import { describe, it, expect } from 'vitest';
import { layoutDiagram, findWireCrossings } from '../../src/renderer/layout.js';
import { parse } from '../../src/parser/index.js';
import { resolveOptions } from '../../src/parser/ast.js';

// #37 prototype: OPTION FANOUT_CONNECTORS draws a very-high-fan-out, wide-span net as off-page
// connector stubs instead of one snaking wire. Default OFF (an opt-in, so the corpus is untouched).
describe('FANOUT_CONNECTORS (off-page fan-out, #37 prototype)', () => {
  // BLK is consumed by many outputs spread down the page — the pattern that makes one wire cross
  // everything (a global inhibit). Connectorising it should not increase crossings and should tag it.
  const body = [
    'BLK = GA AND GB',
    'O1 = C1 AND NOT BLK', 'O2 = C2 AND NOT BLK', 'O3 = C3 AND NOT BLK',
    'O4 = C4 AND NOT BLK', 'O5 = C5 AND NOT BLK', 'O6 = C6 AND NOT BLK',
    'BLK.Name = "Block"',
  ].join('\n');

  it('is off by default (no connector tags, net drawn as a wire)', () => {
    const l = layoutDiagram(parse(body).diagram, resolveOptions([]));
    expect(l.labels.some(x => x.connector)).toBe(false);
  });

  it('draws connector tags and does not increase crossings when enabled', () => {
    const wired = layoutDiagram(parse(body).diagram, resolveOptions([]));
    const conn = layoutDiagram(parse('OPTION FANOUT_CONNECTORS = TRUE\n' + body).diagram, resolveOptions(parse('OPTION FANOUT_CONNECTORS = TRUE\n' + body).diagram.options));
    // The high-fan-out net is tagged (one source + one per consumer).
    const tags = conn.labels.filter(x => x.connector);
    expect(tags.some(x => x.connector === 'source')).toBe(true);
    expect(tags.filter(x => x.connector === 'sink').length).toBeGreaterThanOrEqual(4);
    // Removing the snaking wire cannot increase crossings here.
    expect(findWireCrossings(conn.wires, conn.junctions).length)
      .toBeLessThanOrEqual(findWireCrossings(wired.wires, wired.junctions).length);
  });
});

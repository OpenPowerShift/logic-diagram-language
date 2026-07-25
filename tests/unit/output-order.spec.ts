import { describe, it, expect } from 'vitest';
import { layoutDiagram, findWireCrossings } from '../../src/renderer/layout.js';
import { parse } from '../../src/parser/index.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { EXAMPLES } from '../../src/examples.js';

// #36: OUTPUT_ORDER = AUTO breaks a source-Y tie by source depth. There is no universally-best
// direction (shallow-wins removes the Shared Intermediates crossing but adds bends to Boolean
// Algebra), so both are tried and the better-rendering one is kept. This test pins that BOTH
// example diagrams get their own optimum at once — the whole point of making it crossing-aware.
function metrics(name: string) {
  const r = parse(EXAMPLES[name]);
  const l = layoutDiagram(r.diagram, resolveOptions(r.diagram.options));
  let bends = 0;
  for (const w of l.wires) { if (!w.feedback) bends += Math.max(0, w.points.length - 2); }
  return { crossings: findWireCrossings(l.wires, l.junctions).length, bends };
}

describe('OUTPUT_ORDER = AUTO crossing-aware tie-break (#36)', () => {
  it('Shared Intermediates keeps its crossing-free-ish ordering (shallow-wins)', () => {
    // The B↔ALARM crossing is avoided: 1 crossing, not 2.
    expect(metrics('Shared Intermediates').crossings).toBeLessThanOrEqual(1);
  });

  it('Boolean Algebra keeps its low-bend ordering (deep-wins) — no static-tie-break penalty', () => {
    // The static shallow-wins tie-break added 2 bends here; crossing-aware selection avoids them.
    const m = metrics('Boolean Algebra');
    expect(m.crossings).toBeLessThanOrEqual(1);
    expect(m.bends).toBeLessThanOrEqual(8);
  });
});

import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram, findWireCrossings } from '../../src/renderer/layout.js';
import type { LayoutResult } from '../../src/renderer/layout.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { EXAMPLES } from '../../src/examples.js';

// Placement-quality instrument for the bend-aware coordinate-assignment work (direction #2).
// A higher-level, human-readable dashboard than the geometry snapshot: it counts how many wires
// are straight vs bent and how many cross, per example, and tracks the diagram's pixel height.
// Snapshotting it makes the *quality* effect of a placement change obvious (e.g. "Boolean
// Algebra: bent 3 -> 1") and guards against silent regressions — including height ballooning
// (an unbounded 2-hop input placement once sent Complex Protection (SEL) from 1075px to 4490px;
// the height field turns that into a reviewable failing diff). Run `vitest -u` to accept an
// intended change.
function metrics(l: LayoutResult) {
  let straight = 0, bent = 0, bends = 0;
  for (const w of l.wires) {
    if (w.feedback) continue;
    let dirChanges = 0;
    for (let i = 1; i < w.points.length - 1; i++) {
      const a = w.points[i - 1], b = w.points[i], c = w.points[i + 1];
      const d1h = Math.abs(a.y - b.y) < 0.5, d2h = Math.abs(b.y - c.y) < 0.5;
      if (d1h !== d2h) dirChanges++;
    }
    bends += dirChanges;
    if (dirChanges === 0) straight++; else bent++;
  }
  return { wires: straight + bent, straight, bent, bends, crossings: findWireCrossings(l.wires, l.junctions).length, H: l.height };
}

describe('Bend/crossing metrics', () => {
  for (const [name, src] of Object.entries(EXAMPLES)) {
    it(name, () => {
      const r = parse(src);
      const l = layoutDiagram(r.diagram, r.diagram.portMeta, resolveOptions(r.diagram.options));
      expect(metrics(l)).toMatchSnapshot();
    });
  }
});

// Hard crossing CEILING — the guardrail that stops crossovers silently creeping back. Each example's
// rendered crossings must stay AT OR BELOW its recorded baseline; a change that adds a crossing fails
// the build. Lowering a ceiling (an improvement) is a deliberate, reviewed edit here. Default is 0 —
// most schematics must render crossing-free; only genuinely reconvergent cases carry a nonzero
// ceiling, documented by the value. (The `-u` snapshot above tracks exact counts; this asserts the
// one-directional guarantee.)
const CROSSING_CEILING: Record<string, number> = {
  'Shared Intermediates': 4,      // COMPARE fan-out + SR seal-in reconvergence
  'Inversion Bubbles': 5,         // dense multi-output fan-out; +1 vs old baseline is the accepted
                                  // cost of the OUTPUT_ORDER = AUTO default (a clean crossing, not an
                                  // overlap — the topological in↔in swap now renders as a crossover)
  'Boolean Algebra': 1,
  'Motor Control Circuit': 1,
};
describe('Crossing ceiling (never regress)', () => {
  for (const [name, src] of Object.entries(EXAMPLES)) {
    it(name, () => {
      const r = parse(src);
      const l = layoutDiagram(r.diagram, r.diagram.portMeta, resolveOptions(r.diagram.options));
      const crossings = findWireCrossings(l.wires, l.junctions).length;
      const ceiling = CROSSING_CEILING[name] ?? 0;
      expect(crossings, `${name}: ${crossings} crossings exceeds ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling);
    });
  }
});

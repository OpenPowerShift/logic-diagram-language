import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram } from '../../src/renderer/layout.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { EXAMPLES } from '../../src/examples.js';

// Regression for the A* router's diagonal fallback: when a wire can't be routed orthogonally in
// the search region, the router used to return a direct (diagonal) source→dest line. It must now
// fall back to an orthogonal Z. These cases exercise it via heavily cross-connected, labelled
// intermediates (lots of label obstacles fanning across the diagram) that previously produced
// non-orthogonal segments.
const STRESS: Record<string, string> = {
  'cross-connected labelled gates': `OPTION OUTPUT_ORDER = AUTO
PH=O51 OR O50 OR NEGSEQ
EF=E51N OR E50N
PERM=NOT HBLK AND NOT LOCKOUT
OC=PH AND PERM
TRIP=OC OR EF OR O502
ALARM=PH OR EF
PH.Name="Phase OC"
EF.Name="Earth Fault"
PERM.Name="Permissive"
OC.Name="Phase Trip"`,
};

function diagonalSegments(src: string): number {
  const r = parse(src);
  const l = layoutDiagram(r.diagram, r.diagram.portMeta, resolveOptions(r.diagram.options));
  let diag = 0;
  for (const w of l.wires) {
    for (let i = 0; i < w.points.length - 1; i++) {
      const a = w.points[i], b = w.points[i + 1];
      if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) diag++;
    }
  }
  return diag;
}

describe('Router never emits a diagonal segment', () => {
  for (const [name, src] of Object.entries(STRESS)) {
    it(name, () => expect(diagonalSegments(src)).toBe(0));
  }
  it('every built-in example is fully orthogonal', () => {
    for (const [name, src] of Object.entries(EXAMPLES)) {
      expect(diagonalSegments(src), `${name} has a diagonal segment`).toBe(0);
    }
  });
});

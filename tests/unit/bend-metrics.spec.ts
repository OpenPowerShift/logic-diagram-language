import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram, findWireCrossings } from '../../src/renderer/layout.js';
import type { LayoutResult } from '../../src/renderer/layout.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { EXAMPLES } from '../../src/examples.js';

// Placement-quality instrument for the bend-aware coordinate-assignment work (direction #2).
// A higher-level, human-readable dashboard than the geometry snapshot: it counts how many wires
// are straight vs bent and how many cross, per example. Snapshotting it makes the *quality* effect
// of a placement change obvious (e.g. "Boolean Algebra: bent 3 -> 1") and guards against silent
// regressions. Run `vitest -u` to accept an intended change.
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
  return { wires: straight + bent, straight, bent, bends, crossings: findWireCrossings(l.wires, l.junctions).length };
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

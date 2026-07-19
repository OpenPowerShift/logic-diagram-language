import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram } from '../../src/renderer/layout.js';
import type { LayoutResult } from '../../src/renderer/layout.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { EXAMPLES } from '../../src/examples.js';

// Golden visual-regression: a deterministic, id-independent geometry digest of each example's
// layout. A behaviour-preserving refactor must leave these snapshots unchanged; a deliberate
// layout change shows up as a reviewable snapshot diff (run `vitest -u` to accept it). The digest
// is canonicalised (every list sorted) so node/wire creation order — and the uid counter — don't
// affect it; only the actual geometry does.
const r2 = (n: number) => Math.round(n);

function geometryDigest(l: LayoutResult): unknown {
  const nodes = l.nodes
    .map(n => ({
      type: n.gateType,
      block: n.blockType ?? null,
      box: [r2(n.absX), r2(n.absY), r2(n.width), r2(n.height)],
      label: n.label ?? null,
      name: n.name ?? null,
      desc: n.description ?? null,
      inputs: n.inputs
        .map(p => [r2(p.absX), r2(p.absY), p.name, p.label ?? null, p.bubbled ? 1 : 0])
        .sort(cmp),
      outputs: n.outputs
        .map(p => [r2(p.absX), r2(p.absY), p.name, p.bubbledOutput ? 1 : 0])
        .sort(cmp),
    }))
    .sort(cmp);
  const wires = l.wires
    .map(w => ({ feedback: w.feedback ? 1 : 0, points: w.points.map(p => [r2(p.x), r2(p.y)]) }))
    .sort(cmp);
  const junctions = l.junctions.map(j => [r2(j.x), r2(j.y)]).sort(cmp);
  const labels = l.labels
    .map(x => [r2(x.x), r2(x.y), r2(x.width), r2(x.height), x.name ?? null, x.description ?? null])
    .sort(cmp);
  return { canvas: [r2(l.width), r2(l.height)], nodes, wires, junctions, labels };
}

function cmp(a: unknown, b: unknown): number {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

describe('Visual regression (layout geometry)', () => {
  for (const [name, src] of Object.entries(EXAMPLES)) {
    it(name, () => {
      const r = parse(src);
      expect(r.errors, `${name} parse errors`).toEqual([]);
      const l = layoutDiagram(r.diagram, resolveOptions(r.diagram.options));
      expect(geometryDigest(l)).toMatchSnapshot();
    });
  }
});

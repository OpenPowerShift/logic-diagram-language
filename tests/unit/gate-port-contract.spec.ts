import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram } from '../../src/renderer/layout.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { EXAMPLES } from '../../src/examples.js';

// The gate vertical-layout contract that every placement pass must preserve, and that the
// per-gate-port-spacing refactor must keep invariant at each step. For every AND/OR gate:
//  - the single output port is vertically centred on the body (on-grid);
//  - input ports are strictly top-to-bottom ordered and all lie within the body;
//  - adjacent input ports are at least PORT_SPACING (15px) apart.
// (Bar-tapped inputs in GATE_INPUT_STYLE = BARS sit on a bar offset to the left and are exempt
// from the in-body X check; their Y still obeys ordering/spacing.)
const PORT_SPACING = 15;
const GRID = 5;

describe('Gate port-layout contract', () => {
  for (const [name, src] of Object.entries(EXAMPLES)) {
    it(name, () => {
      const r = parse(src);
      const l = layoutDiagram(r.diagram, resolveOptions(r.diagram.options));
      for (const g of l.nodes) {
        if (g.gateType !== 'AND' && g.gateType !== 'OR') continue;
        // output dead-centre
        expect(g.outputs.length, `${name}/${g.id} output count`).toBe(1);
        const centre = Math.round((g.absY + g.height / 2) / GRID) * GRID;
        expect(Math.abs(g.outputs[0].absY - centre) <= GRID + 0.5, `${name}/${g.id} output not centred (${g.outputs[0].absY} vs ${centre})`).toBe(true);
        // input ports ordered, in body, spaced
        const ys = g.inputs.map(p => p.absY);
        for (let i = 1; i < ys.length; i++) {
          expect(ys[i] - ys[i - 1] >= PORT_SPACING - 0.5, `${name}/${g.id} ports too close: ${ys[i - 1]} -> ${ys[i]}`).toBe(true);
        }
        for (const p of g.inputs) {
          expect(p.absY >= g.absY - 0.5 && p.absY <= g.absY + g.height + 0.5, `${name}/${g.id} port ${p.absY} outside body ${g.absY}..${g.absY + g.height}`).toBe(true);
        }
      }
    });
  }
});

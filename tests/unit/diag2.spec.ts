import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram } from '../../src/renderer/layout.js';

function rectsOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number, pad: number = 0) {
  return !(ax + aw + pad < bx || bx + bw + pad < ax || ay + ah + pad < by || by + bh + pad < ay);
}

function check(name: string, src: string) {
  it(name, () => {
    const r = parse(src);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta);
    const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
    console.log(`\n=== ${name} ===`);
    for (const g of gates) {
      console.log(`${g.id} ${g.gateType} depth=${g.depth} x=${g.absX} y=${g.absY} w=${g.width} h=${g.height} right=${g.absX+g.width} bottom=${g.absY+g.height}`);
    }
    for (const w of l.wires) {
      for (let i = 0; i < w.points.length - 1; i++) {
        const p0 = w.points[i], p1 = w.points[i + 1];
        const isHoriz = Math.abs(p0.y - p1.y) < 1;
        const isVert = Math.abs(p0.x - p1.x) < 1;
        if (!isHoriz && !isVert) continue;
        for (const g of gates) {
          if (g.id === w.fromId || g.id === w.toId) continue;
          let overlaps = false;
          if (isHoriz) {
            const xMin = Math.min(p0.x, p1.x), xMax = Math.max(p0.x, p1.x);
            if (xMax - xMin < 1) continue;
            overlaps = rectsOverlap(xMin, p0.y - 4, xMax - xMin, 8, g.absX, g.absY, g.width, g.height, 2);
          } else {
            const yMin = Math.min(p0.y, p1.y), yMax = Math.max(p0.y, p1.y);
            if (yMax - yMin < 1) continue;
            overlaps = rectsOverlap(p0.x - 4, yMin, 8, yMax - yMin, g.absX, g.absY, g.width, g.height, 2);
          }
          if (overlaps) {
            console.log(`HIT: wire ${w.fromId}->${w.toId} seg[${i}] (${Math.round(p0.x)},${Math.round(p0.y)})-(${Math.round(p1.x)},${Math.round(p1.y)}) through ${g.id} (${g.gateType})`);
          }
        }
      }
    }
  });
}

describe('wire-gate hits', () => {
  check('Inversion Bubbles', `OPTION INVERSION = BUBBLES
O1 = I1 AND NOT I2 AND I3
O2 = NOT (I1 AND I3)
O3 = NOT I2
O4 = NOT NOT I3`);
  check('Differential Protection', `O1 = (I1 AND NOT I2) AND NOT I3\nO2 = NOT I3`);
  check('Boolean Algebra', `O1 = A AND B\nO2 = A OR B\nO3 = NOT A\nO4 = NOT (A AND B)`);
});

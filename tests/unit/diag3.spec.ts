import { it } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram } from '../../src/renderer/layout.js';

function rectsOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number, pad: number = 0) {
  return !(ax + aw + pad < bx || bx + bw + pad < ax || ay + ah + pad < by || by + bh + pad < ay);
}

it('Boolean Algebra', () => {
  const src = `O1 = A AND B\nO2 = A OR B\nO3 = NOT A\nO4 = NOT (A AND B)`;
  const r = parse(src);
  const l = layoutDiagram(r.diagram, r.diagram.portMeta);
  const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
  for (const g of gates) {
    console.log(`${g.id} ${g.gateType} depth=${g.depth} x=${g.absX} y=${g.absY} w=${g.width} h=${g.height} right=${g.absX+g.width} bottom=${g.absY+g.height}`);
  }
  console.log('\nWires:');
  for (const w of l.wires) {
    const pts = w.points.map(p => `(${Math.round(p.x)},${Math.round(p.y)})`).join(' ');
    console.log(` ${w.fromId}->${w.toId}: ${pts}`);
  }
  console.log('\nGate hits:');
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
          console.log(` HIT: wire ${w.fromId}->${w.toId} seg[${i}] (${Math.round(p0.x)},${Math.round(p0.y)})-(${Math.round(p1.x)},${Math.round(p1.y)}) through ${g.id} (${g.gateType})`);
        }
      }
    }
  }
});

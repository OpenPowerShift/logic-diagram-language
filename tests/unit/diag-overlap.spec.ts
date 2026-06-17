import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram } from '../../src/renderer/layout.js';

function rectsOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number, pad: number = 0) {
  return !(ax + aw + pad < bx || bx + bw + pad < ax || ay + ah + pad < by || by + bh + pad < ay);
}

// Inversion Bubbles
it('diag Inversion Bubbles', () => {
  const src = `O1 = I1 AND NOT I2 AND I3
O2 = NOT (I1 AND I3)
O3 = NOT I2
O4 = NOT NOT I3`;
  const r = parse(src);
  const l = layoutDiagram(r.diagram, r.diagram.portMeta);
  const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
  for (const g of gates) {
    console.log(`${g.id} ${g.gateType} depth=${g.depth} x=${g.absX} y=${g.absY} w=${g.width} h=${g.height} right=${g.absX+g.width} bottom=${g.absY+g.height}`);
  }
  for (let i = 0; i < gates.length; i++) {
    for (let j = i + 1; j < gates.length; j++) {
      const a = gates[i], b = gates[j];
      const ax1 = a.absX, ax2 = a.absX + a.width;
      const bx1 = b.absX, bx2 = b.absX + b.width;
      const ay1 = a.absY, ay2 = a.absY + a.height;
      const by1 = b.absY, by2 = b.absY + b.height;
      const ox = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
      const oy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
      if (ox * oy > 0) console.log(`OVERLAP: ${a.id} & ${b.id}: ${ox}*${oy}=${ox*oy}`);
    }
  }
});

// Boolean Algebra  
it('diag Boolean Algebra', () => {
  const src = `O1 = A AND B\nO2 = A OR B\nO3 = NOT A\nO4 = NOT (A AND B)`;
  const r = parse(src);
  const l = layoutDiagram(r.diagram, r.diagram.portMeta);
  const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
  for (const g of gates) {
    console.log(`${g.id} ${g.gateType} depth=${g.depth} x=${g.absX} y=${g.absY} w=${g.width} h=${g.height} right=${g.absX+g.width} bottom=${g.absY+g.height}`);
  }
  for (let i = 0; i < gates.length; i++) {
    for (let j = i + 1; j < gates.length; j++) {
      const a = gates[i], b = gates[j];
      const ax1 = a.absX, ax2 = a.absX + a.width;
      const bx1 = b.absX, bx2 = b.absX + b.width;
      const ay1 = a.absY, ay2 = a.absY + a.height;
      const by1 = b.absY, by2 = b.absY + b.height;
      const ox = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
      const oy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
      if (ox * oy > 0) console.log(`OVERLAP: ${a.id} & ${b.id}: ${ox}*${oy}=${ox*oy}`);
    }
  }
});

// Inversion Bubbles wire-through-gate
it('diag Inversion Bubbles wires', () => {
  const src = `O1 = I1 AND NOT I2 AND I3
O2 = NOT (I1 AND I3)
O3 = NOT I2
O4 = NOT NOT I3
OPTION INVERSION = BUBBLES`;
  const r = parse(src);
  const l = layoutDiagram(r.diagram, r.diagram.portMeta);
  const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
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
          const xMin = Math.min(p0.x, p1.x);
          const xMax = Math.max(p0.x, p1.x);
          if (xMax - xMin < 1) continue;
          overlaps = rectsOverlap(xMin, p0.y - 4, xMax - xMin, 8, g.absX, g.absY, g.width, g.height, 2);
        } else {
          const yMin = Math.min(p0.y, p1.y);
          const yMax = Math.max(p0.y, p1.y);
          if (yMax - yMin < 1) continue;
          overlaps = rectsOverlap(p0.x - 4, yMin, 8, yMax - yMin, g.absX, g.absY, g.width, g.height, 2);
        }
        if (overlaps) console.log(`GATE HIT: wire ${w.fromId}->${w.toId} seg[${i}] at (${Math.round(p0.x)},${Math.round(p0.y)})-(${Math.round(p1.x)},${Math.round(p1.y)}) through ${g.id} (${g.gateType})`);
      }
    }
  }
});

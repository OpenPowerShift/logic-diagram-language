import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram, findWireCrossings } from '../../src/renderer/layout.js';

function rectsOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number, pad: number = 0): boolean {
  return !(ax + aw + pad < bx || bx + bw + pad < ax || ay + ah + pad < by || by + bh + pad < ay);
}


describe('Common Subexpression Deduplication', () => {
  it('deduplicates AND subexpression across outputs', () => {
    const src = `O1 = A AND B\nO4 = NOT (A AND B)`;
    const r = parse(src);
    const l = layoutDiagram(r.diagram);
    const andGates = l.nodes.filter(n => n.gateType === 'AND');
    expect(andGates).toHaveLength(1);
  });

  it('deduplicates NOT subexpression across outputs', () => {
    const src = `O1 = (I1 AND NOT I2) AND NOT I3\nO2 = NOT I3`;
    const r = parse(src);
    const l = layoutDiagram(r.diagram);
    const notGates = l.nodes.filter(n => n.gateType === 'NOT');
    // Should have exactly 2 NOTs: one for NOT I2, one for NOT I3
    expect(notGates).toHaveLength(2);
  });

  it('deduplicates commutative AND with reversed inputs', () => {
    const src = `O1 = I1 AND I2\nO2 = I2 AND I1`;
    const r = parse(src);
    const l = layoutDiagram(r.diagram);
    const andGates = l.nodes.filter(n => n.gateType === 'AND');
    expect(andGates).toHaveLength(1);
  });

  it('does not deduplicate non-commutative NOT with different inputs', () => {
    const src = `O1 = NOT I1\nO2 = NOT I2`;
    const r = parse(src);
    const l = layoutDiagram(r.diagram);
    const notGates = l.nodes.filter(n => n.gateType === 'NOT');
    expect(notGates).toHaveLength(2);
  });

  it('Boolean Algebra example has no overlapping gates', () => {
    const src = `O1 = A AND B\nO2 = A OR B\nO3 = NOT A\nO4 = NOT (A AND B)`;
    const r = parse(src);
    const l = layoutDiagram(r.diagram);
    const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
    for (let i = 0; i < gates.length; i++) {
      for (let j = i + 1; j < gates.length; j++) {
        const a = gates[i], b = gates[j];
        const ax1 = a.absX, ax2 = a.absX + a.width;
        const bx1 = b.absX, bx2 = b.absX + b.width;
        const ay1 = a.absY, ay2 = a.absY + a.height;
        const by1 = b.absY, by2 = b.absY + b.height;
        const overlapX = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
        const overlapY = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
        expect(overlapX * overlapY).toBe(0);
      }
    }
  });

  it('Differential Protection has no overlapping gates', () => {
    const src = `O1 = (I1 AND NOT I2) AND NOT I3\nO2 = NOT I3`;
    const r = parse(src);
    const l = layoutDiagram(r.diagram);
    const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
    for (let i = 0; i < gates.length; i++) {
      for (let j = i + 1; j < gates.length; j++) {
        const a = gates[i], b = gates[j];
        const ax1 = a.absX, ax2 = a.absX + a.width;
        const bx1 = b.absX, bx2 = b.absX + b.width;
        const ay1 = a.absY, ay2 = a.absY + a.height;
        const by1 = b.absY, by2 = b.absY + b.height;
        const overlapX = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
        const overlapY = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
        expect(overlapX * overlapY).toBe(0);
      }
    }
  });
});

describe('BFI Crossover', () => {
  it('BFI wire does not pass through OR gate body', () => {
    const src = `BFT = BFI OR X AND ((CB52A AND CB52ABFY) OR (I1I2 AND INOM))
BFI.Description = "Relay Word Bit"
CB52A.Name = "52A"
CB52ABFY.Name = "52ABF = Y"
CB52ABFY.Description = "Setting"
I1I2.Name = "\u0024Test\u0024"
INOM.Name = "\u00240.02\u0024"`;
    const r = parse(src);
    const l = layoutDiagram(r.diagram);
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
          expect(overlaps).toBe(false);
        }
      }
    }
  });
});

describe('A* Router Edge Cases', () => {
  it('routes around a gate that blocks direct path', () => {
    const src = `O1 = A AND B\nO2 = C AND D\nO3 = (A AND B) OR (C AND D)`;
    const r = parse(src);
    const l = layoutDiagram(r.diagram);
    const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
    for (const w of l.wires) {
      for (let i = 0; i < w.points.length - 1; i++) {
        const p0 = w.points[i], p1 = w.points[i + 1];
        const isHoriz = Math.abs(p0.y - p1.y) < 1;
        const isVert = Math.abs(p0.x - p1.x) < 1;
        expect(isHoriz || isVert).toBe(true);
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
          expect(overlaps).toBe(false);
        }
      }
    }
  });

  it('routes multiple wires to same gate without overlap', () => {
    const src = `O1 = A AND B AND C`;
    const r = parse(src);
    const l = layoutDiagram(r.diagram);
    const crossings = findWireCrossings(l.wires, l.junctions);
    expect(crossings).toHaveLength(0);
  });

  it('right-to-left wire enters dest gate from the left', () => {
    const src = `O1 = NOT A\nO2 = NOT B\nO3 = (NOT A) AND (NOT B)`;
    const r = parse(src);
    const l = layoutDiagram(r.diagram);
    for (const w of l.wires) {
      const lastPoint = w.points[w.points.length - 1];
      const secondLast = w.points[w.points.length - 2];
      const toNode = l.nodes.find(n => n.id === (w as any).toId);
      if (!toNode || toNode.gateType === 'OUTPUT') continue;
      if (lastPoint && secondLast) {
        const approachingFromLeft = secondLast.x <= lastPoint.x + 1;
        expect(approachingFromLeft).toBe(true);
      }
    }
  });

  it('complex circuit with no gate collisions', () => {
    const src = `O1 = A AND B\nO2 = C OR D\nO3 = NOT E\nO4 = (A AND B) OR (NOT E)`;
    const r = parse(src);
    const l = layoutDiagram(r.diagram);
    const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
    for (let i = 0; i < gates.length; i++) {
      for (let j = i + 1; j < gates.length; j++) {
        const a = gates[i], b = gates[j];
        const overlapX = Math.max(0, Math.min(a.absX + a.width, b.absX + b.width) - Math.max(a.absX, b.absX));
        const overlapY = Math.max(0, Math.min(a.absY + a.height, b.absY + b.height) - Math.max(a.absY, b.absY));
        expect(overlapX * overlapY).toBe(0);
      }
    }
  });
});

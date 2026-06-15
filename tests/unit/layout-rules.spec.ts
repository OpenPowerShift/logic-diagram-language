import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram, findWireCrossings } from '../../src/renderer/layout.js';
import type { LayoutWire } from '../../src/renderer/layout.js';
import { MIN_DOGLEG } from '../../src/renderer/layout.js';

interface Segment { x1: number; y1: number; x2: number; y2: number; fromId: string; toId: string; }

function extractSegments(wires: { points: { x: number; y: number }[]; fromId: string; toId: string }[]): Segment[] {
  const segs: Segment[] = [];
  for (const w of wires) {
    for (let i = 0; i < w.points.length - 1; i++) {
      segs.push({ x1: w.points[i].x, y1: w.points[i].y, x2: w.points[i+1].x, y2: w.points[i+1].y, fromId: w.fromId, toId: w.toId });
    }
  }
  return segs;
}

function findOverlappingVerticals(segs: Segment[]): { seg1: Segment; seg2: Segment; overlapY: [number, number] }[] {
  const violations: { seg1: Segment; seg2: Segment; overlapY: [number, number] }[] = [];
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    if (Math.abs(a.x2 - a.x1) > 2) continue;
    const aMinY = Math.min(a.y1, a.y2);
    const aMaxY = Math.max(a.y1, a.y2);
    if (aMaxY - aMinY < 5) continue;
    for (let j = i + 1; j < segs.length; j++) {
      const b = segs[j];
      if (Math.abs(b.x2 - b.x1) > 2) continue;
      const bMinY = Math.min(b.y1, b.y2);
      const bMaxY = Math.max(b.y1, b.y2);
      if (bMaxY - bMinY < 5) continue;
      if (Math.abs(a.x1 - b.x1) > 2) continue;
      if (a.fromId === b.fromId && a.toId === b.toId) continue;
      const overlapStart = Math.max(aMinY, bMinY);
      const overlapEnd = Math.min(aMaxY, bMaxY);
      if (overlapEnd - overlapStart > 5) {
        violations.push({ seg1: a, seg2: b, overlapY: [overlapStart, overlapEnd] });
      }
    }
  }
  return violations;
}

function findBackwardWires(wires: { points: { x: number; y: number }[] }[]): { from: string; seg: number }[] {
  const violations: { from: string; seg: number }[] = [];
  for (const w of wires) {
    for (let i = 0; i < w.points.length - 1; i++) {
      if (w.points[i+1].x < w.points[i].x - 5) {
        violations.push({ from: '', seg: i });
      }
    }
  }
  return violations;
}

function findNeedlessDoglegs(wires: { points: { x: number; y: number }[] }[]): number {
  let count = 0;
  for (const w of wires) {
    if (w.points.length === 2) continue;
    if (Math.abs(w.points[0].y - w.points[w.points.length - 1].y) < 1 && w.points.length > 2) {
      count++;
    }
  }
  return count;
}

function findSmallDoglegs(wires: LayoutWire[], nodes: { id: string; outputs: { absX: number; absY: number }[] }[], minDogleg: number): { fromId: string; toId: string; dy: number }[] {
  const violations: { fromId: string; toId: string; dy: number }[] = [];
  for (const w of wires) {
    if (w.points.length <= 2) continue;
    const sourceY = w.points[0].y;
    const targetY = w.points[w.points.length - 1].y;
    const dy = Math.abs(sourceY - targetY);
    if (dy >= 1 && dy < minDogleg) {
      violations.push({ fromId: w.fromId, toId: w.toId, dy: Math.round(dy * 10) / 10 });
    }
  }
  return violations;
}

const examples: [string, string][] = [
  ['Simple AND', 'OUT = A AND B'],
  ['Three-input AND', 'OUT = A AND B AND C'],
  ['Triple OR', 'ALARM = TEMP OR PRESSURE OR FLOW'],
  ['Nested NOT', 'OUT = NOT NOT A'],
  ['Trip Logic', 'TRIP = OVERCURRENT OR (NOT EARTH_FAULT)\nMAIN_TRIP = TRIP AND MANUAL_TRIP'],
  ['Combined', 'CBFPS = AB AND DC OR (NOT DC AND GF)'],
  ['Interlocking', `I1.Name = "CBQ 00 Open"\nI1.Description = "(BI 3.1)"\nI2.Name = "BB Not Earthed"\nI2.Description = "(BI 3.24)"\nI3.Name = "D/S Q01 Open"\nI3.Description = "(BI 3.3)"\nI4.Name = "E/S Q05 Open"\nI4.Description = "(BI 3.5)"\nI5.Name = "KF1 Release"\nI5.Description = "(BI 3.15)"\nI6.Name = "In Remote"\nI6.Description = "(BI 3.11)"\nI7.Name = "SCADA ON"\nI7.Description = "(BI 3.23)"\nI8.Name = "DNP Close Command"\nI8.Description = "(via RTU)"\nI9.Name = "In Local"\nI9.Description = "(BI 3.12)"\nI10.Name = "Close Switch"\nI10.Description = "(BI 3.20)"\nO1 = (I1 AND I2) AND (I3 AND I4 AND NOT I5) AND ((I6 AND I7 AND I8) OR (I9 AND I10))\nO1.Name = "Output"\nO1.Description = "(BO 3.2)"`],
];

describe('Layout Rules', () => {
  for (const [name, src] of examples) {
    describe(name, () => {
      it('has no backward wires', () => {
        const r = parse(src);
        const l = layoutDiagram(r.diagram, r.diagram.portMeta);
        const violations = findBackwardWires(l.wires);
        expect(violations).toHaveLength(0);
      });

      it('has no overlapping vertical segments', () => {
        const r = parse(src);
        const l = layoutDiagram(r.diagram, r.diagram.portMeta);
        const segs = extractSegments(l.wires as any);
        const violations = findOverlappingVerticals(segs);
        expect(violations).toHaveLength(0);
      });

      it('has no needless doglegs (straight when fy==ty)', () => {
        const r = parse(src);
        const l = layoutDiagram(r.diagram, r.diagram.portMeta);
        const count = findNeedlessDoglegs(l.wires as any);
        expect(count).toBe(0);
      });

      it('output wires are straight', () => {
        const r = parse(src);
        const l = layoutDiagram(r.diagram, r.diagram.portMeta);
        for (const w of l.wires) {
          const to = l.nodes.find(n => n.id === (w as any).toId);
          if (to && to.gateType === 'OUTPUT') {
            expect(w.points.length).toBe(2);
          }
        }
      });

      it('wire endpoints connect to target input ports', () => {
        const r = parse(src);
        const l = layoutDiagram(r.diagram, r.diagram.portMeta);
        for (const w of l.wires) {
          const toNode = l.nodes.find(n => n.id === (w as any).toId);
          if (!toNode || toNode.gateType === 'INPUT' || toNode.gateType === 'OUTPUT') continue;
          const lastPoint = w.points[w.points.length - 1];
          const targetPorts = toNode.inputs;
          if (targetPorts.length === 0) continue;
          const targetY = targetPorts[0].absY;
          const closestY = targetPorts.map(p => p.absY).reduce((a, b) => Math.abs(a - lastPoint.y) < Math.abs(b - lastPoint.y) ? a : b);
          expect(Math.abs(lastPoint.y - closestY)).toBeLessThan(1);
        }
      });

      it('wire startpoints connect to source output ports', () => {
        const r = parse(src);
        const l = layoutDiagram(r.diagram, r.diagram.portMeta);
        for (const w of l.wires) {
          const fromNode = l.nodes.find(n => n.id === (w as any).fromId);
          if (!fromNode || fromNode.outputs.length === 0) continue;
          const firstPoint = w.points[0];
          const sourceY = fromNode.outputs[0].absY;
          const sourceX = fromNode.outputs[0].absX;
          expect(Math.abs(firstPoint.y - sourceY)).toBeLessThan(1);
          expect(Math.abs(firstPoint.x - sourceX)).toBeLessThan(1);
        }
      });

      it('gate input ports have minimum vertical gap', () => {
        const r = parse(src);
        const l = layoutDiagram(r.diagram, r.diagram.portMeta);
        for (const node of l.nodes) {
          if (node.inputs.length < 2) continue;
          const sortedPorts = [...node.inputs].sort((a, b) => a.absY - b.absY);
          for (let i = 1; i < sortedPorts.length; i++) {
            const gap = sortedPorts[i].absY - sortedPorts[i - 1].absY;
            expect(gap).toBeGreaterThanOrEqual(15);
          }
        }
      });

      it('gates expand to align ports with close sources', () => {
        const r = parse(src);
        const l = layoutDiagram(r.diagram, r.diagram.portMeta);
        for (const node of l.nodes) {
          if (node.inputs.length < 2) continue;
          const baseHeight = Math.max(44, node.inputs.length * 22 + 8);
          if (node.height > baseHeight) {
            expect(node.height - baseHeight).toBeLessThanOrEqual(node.inputs.length * 22 + 22);
          }
        }
      });

      it('has no wire-wire crossings', () => {
        const r = parse(src);
        const l = layoutDiagram(r.diagram, r.diagram.portMeta);
        const crossings = findWireCrossings(l.wires, l.junctions);
        expect(crossings).toHaveLength(0);
      });

      it('has no small doglegs (all doglegs >= MIN_DOGLEG or straight)', () => {
        const r = parse(src);
        const l = layoutDiagram(r.diagram, r.diagram.portMeta);
        const violations = findSmallDoglegs(l.wires, l.nodes, MIN_DOGLEG);
        expect(violations).toHaveLength(0);
      });
    });
  }
});
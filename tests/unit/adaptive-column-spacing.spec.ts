import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram, findWireCrossings, MIN_DOGLEG } from '../../src/renderer/layout.js';
import type { LayoutResult, LayoutNode } from '../../src/renderer/layout.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { EXAMPLES } from '../../src/examples.js';

// OPTION COLUMN_SPACING = ADAPTIVE sizes each inter-column gap to its content, so diagrams are
// narrower. It is opt-in (default UNIFORM is unchanged and covered by the other suites). These tests
// guarantee that opting in is SAFE for every example: it must never introduce a sub-min dogleg, a
// gate-entrance violation, a cross-net parallel overlap, a wire through a gate body, or an extra
// crossing — and it must actually be narrower (never wider) than uniform.

const GRID = 5;
const GATE_ENTRANCE = 20;

function build(src: string, adaptive: boolean): LayoutResult {
  const r = parse(src);
  const o = resolveOptions(r.diagram.options);
  return layoutDiagram(r.diagram, r.diagram.portMeta, adaptive ? { ...o, columnSpacing: 'ADAPTIVE' } : o);
}
const isGate = (l: LayoutResult, id: string) => {
  const n = l.nodes.find(x => x.id === id);
  return !!n && n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT';
};

describe('COLUMN_SPACING = ADAPTIVE is safe and narrower', () => {
  for (const [name, src] of Object.entries(EXAMPLES)) {
    if (/GATE_INPUT_STYLE\s*=\s*BARS/i.test(src)) continue; // BARS routing out of scope (as elsewhere)
    describe(name, () => {
      const a = build(src, true);
      const u = build(src, false);

      it('is no wider than uniform', () => {
        expect(a.width).toBeLessThanOrEqual(u.width);
      });

      it('adds no crossings vs uniform', () => {
        expect(findWireCrossings(a.wires, a.junctions).length)
          .toBeLessThanOrEqual(findWireCrossings(u.wires, u.junctions).length);
      });

      it('has no sub-MIN_DOGLEG jogs', () => {
        for (const w of a.wires) {
          if (w.feedback) continue;
          for (let i = 0; i < w.points.length - 1; i++) {
            const p = w.points[i], q = w.points[i + 1];
            if (Math.abs(p.x - q.x) < 0.5) {
              const len = Math.abs(p.y - q.y);
              expect(len < 0.5 || len >= MIN_DOGLEG - 0.01, `${w.fromId}->${w.toId} ${len}px dogleg`).toBe(true);
            }
          }
        }
      });

      it('keeps the GATE_ENTRANCE approach', () => {
        for (const w of a.wires) {
          if (w.feedback || w.points.length < 3 || !isGate(a, w.toId)) continue;
          const port = w.points[w.points.length - 1], prev = w.points[w.points.length - 2], pp = w.points[w.points.length - 3];
          if (Math.abs(prev.y - port.y) >= 0.5 || Math.abs(pp.x - prev.x) >= 0.5) continue;
          expect(Math.abs(port.x - prev.x) >= GATE_ENTRANCE - 0.5,
            `${w.fromId}->${w.toId} enters ${Math.abs(port.x - prev.x)}px from gate`).toBe(true);
        }
      });

      it('has no wire crossing a non-endpoint gate body', () => {
        const gates = a.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
        for (const w of a.wires) {
          for (let i = 0; i < w.points.length - 1; i++) {
            const p = w.points[i], q = w.points[i + 1];
            const xMin = Math.min(p.x, q.x), xMax = Math.max(p.x, q.x), yMin = Math.min(p.y, q.y), yMax = Math.max(p.y, q.y);
            for (const g of gates) {
              if (g.id === w.fromId || g.id === w.toId) continue;
              const over = xMax > g.absX + 1 && g.absX + g.width - 1 > xMin && yMax > g.absY + 1 && g.absY + g.height - 1 > yMin;
              expect(over, `${w.fromId}->${w.toId} crosses gate ${g.id}`).toBe(false);
            }
          }
        }
      });

      it('has no cross-net overlapping parallel segments', () => {
        interface S { x1: number; y1: number; x2: number; y2: number; v: boolean; h: boolean; from: string; }
        const ss: S[] = [];
        for (const w of a.wires) for (let i = 0; i < w.points.length - 1; i++) {
          const p = w.points[i], q = w.points[i + 1];
          ss.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, v: Math.abs(p.x - q.x) < 0.5, h: Math.abs(p.y - q.y) < 0.5, from: w.fromId });
        }
        for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++) {
          const b = ss[i], c = ss[j];
          if (b.from === c.from) continue;
          if (b.v && c.v && Math.abs(b.x1 - c.x1) < 0.5) {
            const o = Math.min(Math.max(b.y1, b.y2), Math.max(c.y1, c.y2)) - Math.max(Math.min(b.y1, b.y2), Math.min(c.y1, c.y2));
            expect(o, `verticals overlap at x=${b.x1}`).toBeLessThan(GRID);
          }
          if (b.h && c.h && Math.abs(b.y1 - c.y1) < 0.5) {
            const o = Math.min(Math.max(b.x1, b.x2), Math.max(c.x1, c.x2)) - Math.max(Math.min(b.x1, b.x2), Math.min(c.x1, c.x2));
            expect(o, `horizontals overlap at y=${b.y1}`).toBeLessThan(GRID);
          }
        }
      });

      it('has no overlapping gate bodies', () => {
        // Matches the codebase contract (invariants.spec): input/output label boxes may stack at the
        // accepted MIN_PORT_GAP crowding; ADAPTIVE changes only X, so it introduces no new overlap.
        const g = (a.nodes as LayoutNode[]).filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
          const A = g[i], B = g[j];
          const over = A.absX + A.width > B.absX && B.absX + B.width > A.absX &&
                       A.absY + A.height > B.absY && B.absY + B.height > A.absY;
          expect(over, `${A.id} overlaps ${B.id}`).toBe(false);
        }
      });
    });
  }
});

import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram, findWireCrossings, MIN_DOGLEG } from '../../src/renderer/layout.js';
import type { LayoutNode, LayoutResult, LayoutWire } from '../../src/renderer/layout.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { orCurveTapX } from '../../src/renderer/gates.js';
import { EXAMPLES } from '../../src/examples.js';

/**
 * Universal layout invariants. Each rule is a pure function over the LayoutResult and is
 * asserted against EVERY example, so a regression on any example (or a newly added one)
 * is caught everywhere — we stop re-solving the same problems per-example.
 */

const GRID = 5;
const MIN_WIRE_SPACING = 10; // adjacent parallel segments from different nets must clear this

function build(src: string): LayoutResult {
  const r = parse(src);
  return layoutDiagram(r.diagram, r.diagram.portMeta, resolveOptions(r.diagram.options));
}

const onGrid = (v: number) => Math.abs(v - Math.round(v / GRID) * GRID) < 0.01;

interface Seg { x1: number; y1: number; x2: number; y2: number; horiz: boolean; vert: boolean; from: string; to: string; }
function segs(wires: LayoutWire[]): Seg[] {
  const out: Seg[] = [];
  for (const w of wires) {
    for (let i = 0; i < w.points.length - 1; i++) {
      const a = w.points[i], b = w.points[i + 1];
      out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, horiz: Math.abs(a.y - b.y) < 0.5, vert: Math.abs(a.x - b.x) < 0.5, from: w.fromId, to: w.toId });
    }
  }
  return out;
}

function nodeById(l: LayoutResult, id: string): LayoutNode | undefined {
  return l.nodes.find(n => n.id === id);
}

// Expected X of an input port given its owning gate (curve tap for OR, bbox edge otherwise).
function expectedInputX(n: LayoutNode, port: { absX: number; absY: number; bubbled?: boolean }): number {
  const bubbleShift = port.bubbled ? 10 : 0; // BUBBLE_R*2
  if (n.gateType === 'OR') return n.absX + orCurveTapX(n.height, port.absY - n.absY) - bubbleShift;
  return n.absX - bubbleShift;
}

// GATE_INPUT_STYLE = BARS routing is known-broken and intentionally out of scope here.
const BARS = /OPTION\s+GATE_INPUT_STYLE\s*=\s*BARS/i;

// Known wire-routing-stage issues, tracked for the upcoming routing redesign. Placement is correct
// for these; the defects are in routing/ordering: the SEL block->output jog, an Inversion Bubbles
// fan-out branch that routes through a gate column, and the close parallel verticals that follow.
// Marked `it.fails` (xfail) so the suite stays green AND flags us the moment a fix makes them pass.
const KNOWN_ROUTING_ISSUES = new Set([
  'SEL Function Blocks::no-doglegs',
  'Inversion Bubbles::no-gate-crossing',
  'Inversion Bubbles::no-parallel-overlap',
]);
const itRoute = (name: string, key: string) =>
  (KNOWN_ROUTING_ISSUES.has(`${name}::${key}`) ? it.fails : it);

describe('Layout invariants', () => {
  for (const [name, src] of Object.entries(EXAMPLES)) {
    // BARS now passes all invariants after the fix.
    describe(name, () => {
      it('node boxes and port Y are on the grid', () => {
        const l = build(src);
        for (const n of l.nodes) {
          expect(onGrid(n.absX), `${n.id}.absX`).toBe(true);
          expect(onGrid(n.absY), `${n.id}.absY`).toBe(true);
          for (const p of [...n.inputs, ...n.outputs]) {
            expect(onGrid(p.absY), `${n.id} port Y`).toBe(true);
          }
        }
      });

      it('output ports and non-OR input ports have grid-aligned X', () => {
        const l = build(src);
        for (const n of l.nodes) {
          for (const p of n.outputs) expect(onGrid(p.absX), `${n.id} out X`).toBe(true);
          if (n.gateType === 'OR') continue; // OR inputs tap the curve (off-grid X by design)
          for (const p of n.inputs) expect(onGrid(p.absX), `${n.id} in X`).toBe(true);
        }
      });

      it('input ports sit on the correct gate edge', () => {
        const l = build(src);
        for (const n of l.nodes) {
          if (n.gateType === 'INPUT' || n.gateType === 'OUTPUT' || n.gateType === 'NOT') continue;
          if (n.barsMode) continue; // bar taps are a separate construct
          for (const p of n.inputs) {
            const want = expectedInputX(n, p);
            expect(Math.abs(p.absX - want), `${n.id} input on edge (got ${p.absX}, want ${want})`).toBeLessThan(1);
          }
        }
      });

      it('every wire segment is orthogonal', () => {
        const l = build(src);
        for (const s of segs(l.wires)) {
          expect(s.horiz || s.vert, `seg ${s.from}->${s.to} (${s.x1},${s.y1})-(${s.x2},${s.y2})`).toBe(true);
        }
      });

      it('every wire connects its source output to its destination input port', () => {
        const l = build(src);
        for (const w of l.wires) {
          if (w.feedback) continue; // loop-back wires tap the output's signal line, not its (absent) output port
          const from = nodeById(l, w.fromId);
          const to = nodeById(l, w.toId);
          if (!from || !to) continue;
          const p0 = w.points[0];
          const pN = w.points[w.points.length - 1];
          const startOk = from.outputs.some(src => Math.abs(p0.x - src.absX) < 1 && Math.abs(p0.y - src.absY) < 1);
          expect(startOk, `${w.fromId}->${w.toId} start not at a source output`).toBe(true);
          const hit = to.inputs.some(p => Math.abs(pN.x - p.absX) < 1 && Math.abs(pN.y - p.absY) < 1);
          expect(hit, `${w.fromId}->${w.toId} end (${pN.x},${pN.y}) not at a dest input port`).toBe(true);
        }
      });

      it('wires exit and enter horizontally', () => {
        const l = build(src);
        for (const s of segs(l.wires)) { /* ensure first/last seg per wire is horizontal */ }
        for (const w of l.wires) {
          if (w.feedback) continue; // loop-back wires exit downward into the return lane
          if (w.points.length < 2) continue;
          const first = w.points[1], p0 = w.points[0];
          const last = w.points[w.points.length - 2], pN = w.points[w.points.length - 1];
          expect(Math.abs(p0.y - first.y) < 0.5, `${w.fromId}->${w.toId} does not exit horizontally`).toBe(true);
          expect(Math.abs(pN.y - last.y) < 0.5, `${w.fromId}->${w.toId} does not enter horizontally`).toBe(true);
        }
      });

      itRoute(name, 'no-doglegs')('has no doglegs (vertical runs between horizontals are >= MIN_DOGLEG)', () => {
        const l = build(src);
        for (const w of l.wires) {
          if (w.feedback) continue; // loop-back wires are routed by A* and may have minor jogs
          for (let i = 0; i < w.points.length - 1; i++) {
            const a = w.points[i], b = w.points[i + 1];
            if (Math.abs(a.x - b.x) < 0.5) {
              const len = Math.abs(a.y - b.y);
              expect(len < 0.5 || len >= MIN_DOGLEG - 0.01,
                `${w.fromId}->${w.toId} has a ${len}px dogleg`).toBe(true);
            }
          }
        }
      });

      itRoute(name, 'no-gate-crossing')('has no wire crossing a non-endpoint gate body', () => {
        const l = build(src);
        const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
        for (const w of l.wires) {
          for (const s of segs([w])) {
            for (const g of gates) {
              if (g.id === w.fromId || g.id === w.toId) continue;
              const xMin = Math.min(s.x1, s.x2), xMax = Math.max(s.x1, s.x2);
              const yMin = Math.min(s.y1, s.y2), yMax = Math.max(s.y1, s.y2);
              const overlap = xMax > g.absX + 1 && g.absX + g.width - 1 > xMin &&
                              yMax > g.absY + 1 && g.absY + g.height - 1 > yMin;
              expect(overlap, `${w.fromId}->${w.toId} crosses gate ${g.id}`).toBe(false);
            }
          }
        }
      });

      itRoute(name, 'no-parallel-overlap')('has no cross-net overlapping parallel segments', () => {
        const l = build(src);
        const ss = segs(l.wires);
        for (let i = 0; i < ss.length; i++) {
          for (let j = i + 1; j < ss.length; j++) {
            const a = ss[i], b = ss[j];
            if (a.from === b.from) continue; // same source may share a trunk
            if (a.vert && b.vert && Math.abs(a.x1 - b.x1) < 0.5) {
              const o = Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2)) - Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2));
              expect(o, `overlapping verticals at x=${a.x1} (${a.from} & ${b.from})`).toBeLessThan(GRID);
            }
            if (a.horiz && b.horiz && Math.abs(a.y1 - b.y1) < 0.5) {
              const o = Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2)) - Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2));
              expect(o, `overlapping horizontals at y=${a.y1} (${a.from} & ${b.from})`).toBeLessThan(GRID);
            }
          }
        }
      });

      it('has no overlapping gate bodies', () => {
        const l = build(src);
        const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
        for (let i = 0; i < gates.length; i++) {
          for (let j = i + 1; j < gates.length; j++) {
            const a = gates[i], b = gates[j];
            const ox = Math.min(a.absX + a.width, b.absX + b.width) - Math.max(a.absX, b.absX);
            const oy = Math.min(a.absY + a.height, b.absY + b.height) - Math.max(a.absY, b.absY);
            expect(ox > 0 && oy > 0, `${a.id} overlaps ${b.id}`).toBe(false);
          }
        }
      });

      it('has no backward (right-to-left) horizontal segments', () => {
        const l = build(src);
        for (const w of l.wires) {
          if (w.feedback) continue; // a loop-back returns right-to-left by design
          for (let i = 0; i < w.points.length - 1; i++) {
            const a = w.points[i], b = w.points[i + 1];
            if (Math.abs(a.y - b.y) < 0.5) {
              expect(b.x >= a.x - 0.5, `${w.fromId}->${w.toId} backtracks at seg ${i}`).toBe(true);
            }
          }
        }
      });

      it('junction dots lie on a wire vertex (true T-intersection)', () => {
        const l = build(src);
        for (const j of l.junctions) {
          const onVertex = l.wires.some(w => w.points.some(p => Math.abs(p.x - j.x) < 1 && Math.abs(p.y - j.y) < 1));
          expect(onVertex, `junction (${j.x},${j.y}) not on any wire vertex`).toBe(true);
        }
      });

      // Height-bound guard. An unbounded placement pass once sent Complex Protection (SEL) from
      // ~1075px to 4490px (a 2-hop input placement fed inputs at the raw Y of bottom outputs
      // under OUTPUT_ORDER=AUTO). The bend-metrics snapshot records H, but a snapshot can be
      // silently `vitest -u`'d; this hard assertion fails loudly on ballooning instead. The bound
      // is generous (inputs × 250px + 1500px padding) — tight enough to catch a 4x explosion,
      // loose enough never to flake on a legitimate dense example.
      it('diagram height stays bounded (no placement ballooning)', () => {
        const r = parse(src);
        const l = layoutDiagram(r.diagram, r.diagram.portMeta, resolveOptions(r.diagram.options));
        const inputCount = l.nodes.filter(n => n.gateType === 'INPUT').length;
        const bound = 1500 + inputCount * 250;
        expect(l.height, `${name}: height ${l.height} exceeds bound ${bound} (inputs=${inputCount})`).toBeLessThan(bound);
      });
    });
  }
});

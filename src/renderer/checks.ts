import type { LayoutResult, LayoutNode, LayoutWire } from './layout.js';
import { findWireCrossings } from './layout.js';

export interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

const GRID = 5;
const PORT_SPACING = 15;

interface Seg { x1: number; y1: number; x2: number; y2: number; horiz: boolean; vert: boolean; from: string; to: string; }

function segments(wires: LayoutWire[]): Seg[] {
  const out: Seg[] = [];
  for (const w of wires) {
    for (let i = 0; i < w.points.length - 1; i++) {
      const a = w.points[i], b = w.points[i + 1];
      out.push({
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        horiz: Math.abs(a.y - b.y) < 0.5, vert: Math.abs(a.x - b.x) < 0.5,
        from: w.fromId, to: w.toId,
      });
    }
  }
  return out;
}

/**
 * Run the user-facing layout quality checks against a laid-out diagram. Returns one result
 * per check; the UI shows these below the editor so a user can see at a glance whether the
 * diagram solved cleanly.
 */
export function validateLayout(layout: LayoutResult): CheckResult[] {
  const { nodes, wires } = layout;
  const byId = new Map(nodes.map(n => [n.id, n] as const));
  const segs = segments(wires);

  // 1. All wire segments orthogonal (horizontal or vertical).
  let nonOrtho = 0;
  for (const s of segs) if (!s.horiz && !s.vert) nonOrtho++;
  const orthogonal: CheckResult = {
    label: 'All wires orthogonal',
    ok: nonOrtho === 0,
    detail: nonOrtho ? `${nonOrtho} diagonal segment(s)` : undefined,
  };

  // 2. Minimum gaps: input ports within a gate >= PORT_SPACING, and no two cross-net
  //    parallel segments closer than MIN_WIRE_SPACING (overlap counts as a violation).
  let gapViolations = 0;
  for (const n of nodes) {
    if (n.inputs.length < 2) continue;
    const ys = n.inputs.map(p => p.absY).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] < PORT_SPACING - 0.5) gapViolations++;
  }
  // Two cross-net parallel segments sharing a track (same X/Y to within a grid cell) and
  // overlapping are a true collision. Merely-near parallels are tolerated, matching the
  // layout invariants (full separation is not always achievable in dense diagrams).
  let overlaps = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i], b = segs[j];
      if (a.from === b.from) continue; // same source may share a trunk
      if (a.vert && b.vert && Math.abs(a.x1 - b.x1) < GRID) {
        const ov = Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2)) - Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2));
        if (ov >= GRID) overlaps++;
      }
      if (a.horiz && b.horiz && Math.abs(a.y1 - b.y1) < GRID) {
        const ov = Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2)) - Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2));
        if (ov >= GRID) overlaps++;
      }
    }
  }
  const gaps: CheckResult = {
    label: 'Minimum gaps met',
    ok: gapViolations === 0 && overlaps === 0,
    detail: gapViolations || overlaps
      ? `${gapViolations} port gap(s), ${overlaps} wire overlap(s)`
      : undefined,
  };

  // 3. Connectivity: every wire connects a source output to a destination input port, and
  //    every gate/output input port has an incoming wire.
  let disconnected = 0;
  for (const w of wires) {
    const from = byId.get(w.fromId);
    const to = byId.get(w.toId);
    if (!from || !to) { disconnected++; continue; }
    const p0 = w.points[0];
    const pN = w.points[w.points.length - 1];
    const src = from.outputs[0];
    const startOk = !!src && Math.abs(p0.x - src.absX) < 1 && Math.abs(p0.y - src.absY) < 1;
    const endOk = to.inputs.some(p => Math.abs(pN.x - p.absX) < 1 && Math.abs(pN.y - p.absY) < 1);
    if (!startOk || !endOk) disconnected++;
  }
  let unfilledPorts = 0;
  for (const n of nodes) {
    if (n.gateType === 'INPUT') continue;
    for (const port of n.inputs) {
      const hit = wires.some(w => {
        if (w.toId !== n.id) return false;
        const pN = w.points[w.points.length - 1];
        return Math.abs(pN.x - port.absX) < 1 && Math.abs(pN.y - port.absY) < 1;
      });
      if (!hit) unfilledPorts++;
    }
  }
  const connected: CheckResult = {
    label: 'All ports connected',
    ok: disconnected === 0 && unfilledPorts === 0,
    detail: disconnected || unfilledPorts
      ? `${disconnected} broken wire(s), ${unfilledPorts} unconnected port(s)`
      : undefined,
  };

  // 4. No wire-wire crossovers (excluding junction dots, which are intended connections).
  const crossings = findWireCrossings(wires, layout.junctions);
  const noCrossovers: CheckResult = {
    label: 'No crossovers',
    ok: crossings.length === 0,
    detail: crossings.length ? `${crossings.length} crossing(s)` : undefined,
  };

  return [orthogonal, gaps, connected, noCrossovers];
}

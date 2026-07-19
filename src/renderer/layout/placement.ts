import type { FlatNode } from '../graph.js';
import { baseNodeHeight, gateGap, GATE_END_PAD } from './geometry.js';
import {
  GRID, PAD_Y, MIN_PORT_GAP, MIN_DOGLEG, ROW_SPACING, COL_SPACING,
  MIN_WIRE_SPACING, MIN_CHANNEL_SPACING,
} from './types.js';

export function assignCoordinates(
  nodes: Map<string, FlatNode>,
  depthGroups: Map<number, FlatNode[]>,
  rowMap: Map<string, number>,
  maxDepth: number,
  rowSpacing: number,
  laneTight = false,
): Map<string, number> {
  // Feedback edges (input is an output node looped back) are excluded from placement: the
  // back-edge would otherwise drag a gate toward the far-right output it feeds.
  const isFeedback = (inputId: string) => nodes.get(inputId)?.kind === 'output';
  const successors = new Map<string, string[]>();
  for (const n of nodes.values()) {
    for (const id of n.inputIds) {
      if (isFeedback(id)) continue;
      const a = successors.get(id) ?? [];
      a.push(n.id);
      successors.set(id, a);
    }
  }

  const columns: FlatNode[][] = [];
  for (let d = 0; d <= maxDepth; d++) {
    columns[d] = (depthGroups.get(d) ?? []).slice()
      .sort((a, b) => (rowMap.get(a.id) ?? 0) - (rowMap.get(b.id) ?? 0));
  }

  const H = new Map<string, number>();
  for (const n of nodes.values()) H.set(n.id, baseNodeHeight(n));
  const VGAP = Math.max(MIN_PORT_GAP, Math.round(rowSpacing / GRID) * GRID);
  // Minimum centre-to-centre gap between two adjacent inputs in the input column, based on what
  // their actual rendered labels need plus a margin — keeps the input column tight (matching the
  // gate's own height) rather than packing at rowSpacing, which left large white gaps for high
  // fan-in (e.g. 20-input AND had a 1920px stack for a 320px gate). The MIN_PORT_GAP floor
  // preserves the dot diameter; the description line bumps the gap just enough not to overlap
  // an adjacent input's description. Gates keep the rowSpacing-based sep() so routing channels
  // between gate columns stay generous.
  const minInputGap = (a: FlatNode, b: FlatNode): number => {
    // The gate's port-expansion pass enforces MIN_PORT_GAP (25px) between successive ports.
    // For an input to leave the gate-port Ys at their natural (PORT_SPACING=15) positions, the
    // inputs must be at LEAST MIN_PORT_GAP apart — otherwise the expansion pass widens the gate
    // body to match the input column, ballooning it. Add label-line space on top of MIN_PORT_GAP
    // when name/description is present so e.g. a stack of labelled inputs has room for them.
    // A 2×MIN_PORT_GAP floor leaves headroom for multi-consumer inputs (an input feeding two
    // different multi-input gates spans more port-Ys than a single-consumer), keeping the gate
    // expansion pass within budget and avoiding the dogleg-killer's all-or-nothing failure.
    const lineA = (a.name ? 14 : 0) + (a.description ? 10 : 0);
    const lineB = (b.name ? 14 : 0) + (b.description ? 10 : 0);
    return Math.round((MIN_PORT_GAP + 10 + Math.max(lineA, lineB)) / GRID) * GRID;
  };
  // Two adjacent long-edge dummies are parallel WIRE LANES, not gates. Stacking them at the full
  // gate-sized routing channel (VGAP) inflates a column and strands a rank-extreme lane far from its
  // natural line (the "input floated to the top" void). Under `laneTight`, adjacent lanes pack at
  // MIN_DOGLEG instead (a wire leaving one lane into a nearby port still turns with a legal dogleg).
  // This is offered as a candidate layout (see layoutDiagram) and kept only where it measurably
  // improves the geometry, so it can never regress a diagram that relies on the generous spacing. A
  // dummy adjacent to a real GATE always keeps the full channel, so gates never shift toward a lane.
  const LANE_GAP = MIN_DOGLEG;
  const sep = (a: FlatNode, b: FlatNode) => {
    if (a.kind === 'input' && b.kind === 'input') {
      // If both inputs feed a common multi-input gate, space them at that gate's port gap so they
      // land directly on adjacent ports — a straight fan-in with no gate growth. (Clamp to at least
      // half their combined height so labels never overlap.)
      const sa = new Set(successors.get(a.id) ?? []);
      const sharedGap = (successors.get(b.id) ?? [])
        .map(id => (sa.has(id) ? nodes.get(id)?.portGap : undefined))
        .filter((g): g is number => g !== undefined);
      if (sharedGap.length) return Math.max(Math.max(...sharedGap), (H.get(a.id)! + H.get(b.id)!) / 2);
      return Math.min((H.get(a.id)! + H.get(b.id)!) / 2 + VGAP, minInputGap(a, b));
    }
    if (laneTight && (a.gateType === 'DUMMY' || b.gateType === 'DUMMY'))
      return (H.get(a.id)! + H.get(b.id)!) / 2 + LANE_GAP;              // lane↔lane / lane↔gate: pack to a dogleg
    return (H.get(a.id)! + H.get(b.id)!) / 2 + VGAP;                    // gate↔gate (or loose): full channel
  };

  const centre = new Map<string, number>();
  for (let d = 0; d <= maxDepth; d++) {
    const col = columns[d];
    let y = 0;
    for (let i = 0; i < col.length; i++) {
      if (i > 0) y += sep(col[i - 1], col[i]);
      centre.set(col[i].id, y);
    }
  }

  // Weighted isotonic regression (Pool Adjacent Violators) — the exact L2 optimum for
  // min Σ wᵢ(xᵢ − tᵢ)² subject to x non-decreasing. Applied per column after removing the
  // separation gaps (substitute zᵢ = centreᵢ − Σ_{k<i} sepₖ, turning "centre_{i+1} − centreᵢ ≥ sep"
  // into "z monotone"), so a whole column is placed at its JOINT optimum in one shot — no greedy
  // node-at-a-time blocking that leaves a column stuck in a locally-fixed arrangement.
  const pava = (t: number[], w: number[]): number[] => {
    const val: number[] = [], wt: number[] = [], cnt: number[] = [];
    for (let i = 0; i < t.length; i++) {
      let v = t[i], ww = w[i], c = 1;
      while (val.length && val[val.length - 1] > v) {
        const pv = val.pop()!, pw = wt.pop()!, pc = cnt.pop()!;
        v = (v * ww + pv * pw) / (ww + pw); ww += pw; c += pc;
      }
      val.push(v); wt.push(ww); cnt.push(c);
    }
    const out: number[] = [];
    for (let b = 0; b < val.length; b++) for (let k = 0; k < cnt[b]; k++) out.push(val[b]);
    return out;
  };

  // Absolute centre-space Y of the port that `sourceId` feeds in consumer `c`. AND/OR assign ports
  // to sources in ascending Y; a fixed-port block / NOT / output uses its centre.
  const portYForSource = (c: FlatNode, sourceId: string, cCentre: number): number => {
    if ((c.gateType === 'AND' || c.gateType === 'OR') && c.inputIds.length >= 2) {
      const gap = gateGap(c);
      const rank = c.inputIds.filter(id => !isFeedback(id))
        .map(id => ({ id, y: centre.get(id) ?? cCentre }))
        .sort((a, b) => a.y - b.y)
        .findIndex(r => r.id === sourceId);
      if (rank >= 0) return cCentre - H.get(c.id)! / 2 + GATE_END_PAD + rank * gap;
    }
    return cCentre;
  };

  // A node's desired centre = mean over ALL its edges of the centre that draws that edge straight:
  // a source edge wants port_i aligned to source_i; a consumer edge wants the node's output aligned
  // to the consumer's port. Two sources feeding ADJACENT ports of one gate therefore pull to
  // positions ≥ the port gap apart — fan-in spreads to the port spacing rather than crowding (which
  // is what previously forced the cramped-port / sub-MIN-dogleg compromise).
  const nodeTarget = (n: FlatNode): number | null => {
    let sum = 0, wsum = 0;
    const h = H.get(n.id)!, gap = gateGap(n);
    const srcYs = n.inputIds.filter(id => !isFeedback(id))
      .map(id => ({ id, y: centre.get(id) }))
      .filter((s): s is { id: string; y: number } => s.y !== undefined);
    if ((n.gateType === 'AND' || n.gateType === 'OR') && srcYs.length >= 2) {
      srcYs.sort((a, b) => a.y - b.y).forEach((s, rank) => { sum += s.y - (GATE_END_PAD + rank * gap) + h / 2; wsum++; });
    } else {
      for (const s of srcYs) { sum += s.y; wsum++; }
    }
    for (const cid of successors.get(n.id) ?? []) {
      const c = nodes.get(cid), cy = centre.get(cid);
      if (c && cy !== undefined) { sum += portYForSource(c, n.id, cy); wsum++; }
    }
    return wsum === 0 ? null : sum / wsum;
  };

  // Place a whole column at its joint optimum: target per node, then PAVA in gap-removed space.
  // Node weight = its degree, so a well-connected node holds its target more firmly.
  const solveColumn = (col: FlatNode[]) => {
    const n = col.length;
    if (n === 0) return;
    const G: number[] = [0];
    for (let i = 1; i < n; i++) G[i] = G[i - 1] + sep(col[i - 1], col[i]);
    const t: number[] = [], w: number[] = [];
    for (let i = 0; i < n; i++) {
      t.push((nodeTarget(col[i]) ?? centre.get(col[i].id)!) - G[i]);
      w.push(Math.max(1, col[i].inputIds.filter(id => !isFeedback(id)).length + (successors.get(col[i].id) ?? []).length));
    }
    const z = pava(t, w);
    for (let i = 0; i < n; i++) centre.set(col[i].id, z[i] + G[i]);
  };

  // Iterate to convergence, alternating direction so both source and consumer influence propagate.
  // Each column solve is the exact constrained optimum given its neighbours' current positions.
  for (let it = 0; it < 12; it++) {
    if (it % 2 === 0) for (let d = 0; d <= maxDepth; d++) solveColumn(columns[d]);
    else for (let d = maxDepth; d >= 0; d--) solveColumn(columns[d]);
  }

  let minTop = Infinity;
  for (const n of nodes.values()) minTop = Math.min(minTop, centre.get(n.id)! - H.get(n.id)! / 2);
  const result = new Map<string, number>();
  for (const n of nodes.values()) {
    const top = centre.get(n.id)! - H.get(n.id)! / 2 - minTop + PAD_Y;
    result.set(n.id, Math.round(top / GRID) * GRID);
  }
  return result;
}

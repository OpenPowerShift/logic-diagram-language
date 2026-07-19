import type { FlatNode, IntermediateLabel } from '../graph.js';
import { buildGraph } from '../graph.js';
import type { Diagram, PortMeta, RenderOptions } from '../../parser/ast.js';
import { orCurveTapX } from '../gates.js';
import { hasMathContent } from '../math-renderer.js';
import { crossminOrder } from './crossmin.js';
import type { LayoutNode, LayoutPort } from './types.js';
import {
  baseNodeHeight, gateGap, GATE_END_PAD, uid, naturalCompare, gateBodyHeight, gateInputPortY, fbDims, blockSize,
} from './geometry.js';
import {
  GRID, PAD_X, PAD_Y, PORT_SPACING, ROW_SPACING, COL_SPACING, MIN_PORT_GAP, MIN_DOGLEG,
  GATE_W, GATE_W_MULTI, NOT_GATE_H, BUBBLE_R, AND_GATE_H_BASE,
  NOT_GATE_TOTAL_W, INPUT_BAR_OFFSET, INPUT_LABEL_W, OUTPUT_LABEL_W, INPUT_STUB, OUTPUT_STUB,
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


// Build the semantic graph and PLACE every node: sizes each gate/block, assigns column depths and
// vertical coordinates (assignCoordinates), then the placement phases (gate placement, dogleg
// cleanup, input/output snap, block separation, OR curve tap). Returns the placed nodes for routing.
export function placeNodes(
  diagram: Diagram,
  portMeta: PortMeta[],
  opts: RenderOptions,
  strategy: 'heuristic' | 'crossmin',
  laneTight: boolean,
): { nodes: Map<string, FlatNode>; intermediateLabels: IntermediateLabel[]; layoutNodes: LayoutNode[]; nodeMap: Map<string, LayoutNode> } {
  const { nodes, intermediateLabels } = buildGraph(diagram, portMeta, opts, uid);

  // Per-gate first-class port spacing. A multi-input AND/OR fed by a labelled INPUT spaces its
  // ports at a label-safe gap so those inputs can be placed directly on its ports (in
  // assignCoordinates) without their labels colliding — the gate is then sized by port count, not
  // grown to span far-apart sources. Gates fed only by other gates keep the tight PORT_SPACING.
  const INPUT_PORT_GAP = 30;
  for (const n of nodes.values()) {
    if (n.kind !== 'gate' || !n.gateType || n.gateType === 'NOT' || n.inputIds.length < 2) continue;
    if (opts.gateInputStyle === 'BARS' && n.inputIds.length > 2) continue; // BARS gates own their port layout
    // Only widen ports for a labelled input that is ADJACENT (one column left), because only then
    // is the input actually placed ON the port (a straight fan-in whose label needs the room). A
    // labelled input feeding a deeper gate is columns away and doglegs in regardless, so widening
    // there just bloats the gate — keep it at the tight PORT_SPACING.
    const hasAdjacentInputSource = n.inputIds.some(id => {
      const s = nodes.get(id);
      return s?.kind === 'input' && s.depth === n.depth - 1;
    });
    if (hasAdjacentInputSource) n.portGap = INPUT_PORT_GAP;
  }

  const rowMap = new Map<string, number>();

  const depthGroups = new Map<number, FlatNode[]>();
  for (const n of nodes.values()) {
    if (!depthGroups.has(n.depth)) depthGroups.set(n.depth, []);
    depthGroups.get(n.depth)!.push(n);
  }

  const inputGroup = depthGroups.get(0) ?? [];
  inputGroup.sort((a, b) => naturalCompare(a.label ?? a.id, b.label ?? b.id));
  for (let i = 0; i < inputGroup.length; i++) {
    rowMap.set(inputGroup[i].id, i);
  }

  const maxDepth = Math.max(...Array.from(nodes.values()).map(n => n.depth), 0);

  for (let depth = 1; depth <= maxDepth; depth++) {
    const group = depthGroups.get(depth) ?? [];
    for (const node of group) {
      if (node.inputIds.length === 0) {
        rowMap.set(node.id, 0);
        continue;
      }
      const inputRows = node.inputIds
        .map(id => rowMap.get(id))
        .filter((r): r is number => r !== undefined);
      if (inputRows.length === 0) {
        rowMap.set(node.id, 0);
        continue;
      }
      const minR = Math.min(...inputRows);
      const maxR = Math.max(...inputRows);
      rowMap.set(node.id, (minR + maxR) / 2);
    }
  }

  // Fixed-port blocks (SR, timers, comparators, edge-triggers, FB) bind their arguments to ports
  // in a FIXED order — unlike AND/OR, which assign ports by ascending source Y and so never cross.
  // Bias a source's barycentre row by the port index it feeds (top port → lower row) so the two
  // sources land in port order and their wires don't cross entering the block. The bias (±<1 row)
  // only breaks ties / near-ties between siblings; it never reorders across distinct gate rows.
  const FIXED_PORT = (gt?: string) => !!gt && !['AND', 'OR', 'NOT', 'DUMMY', 'INPUT', 'OUTPUT'].includes(gt);
  const portBias = (consumer: FlatNode, inputId: string): number => {
    if (!FIXED_PORT(consumer.gateType) || consumer.inputIds.length < 2) return 0;
    const idx = consumer.inputIds.indexOf(inputId);
    return idx < 0 ? 0 : (idx - (consumer.inputIds.length - 1) / 2) * 0.5;
  };

  // INPUT_ORDER = AUTO (default): reorder input rows by the Sugiyama barycentre method to
  // minimise wire crossings. INPUT_ORDER = DECLARATION: keep inputs in their declared
  // (natural-sorted) order and only propagate gate rows from that fixed input order.
  const barycentreIterations = opts.inputOrder === 'AUTO' ? 3 : 0;
  for (let iteration = 0; iteration < barycentreIterations; iteration++) {
    const sortedInputGroup = [...inputGroup];
    for (const node of sortedInputGroup) {
      const downNodes = Array.from(nodes.values()).filter(n => n.inputIds.includes(node.id));
      if (downNodes.length > 0) {
        const bary = downNodes.reduce((s, n) => s + (rowMap.get(n.id) ?? 0) + portBias(n, node.id), 0) / downNodes.length;
        rowMap.set(node.id, bary);
      }
    }
    sortedInputGroup.sort((a, b) => (rowMap.get(a.id) ?? 0) - (rowMap.get(b.id) ?? 0));
    for (let i = 0; i < sortedInputGroup.length; i++) {
      rowMap.set(sortedInputGroup[i].id, i);
    }

    for (let depth = 1; depth <= maxDepth; depth++) {
      const group = depthGroups.get(depth) ?? [];
      for (const node of group) {
        if (node.inputIds.length === 0) {
          rowMap.set(node.id, 0);
          continue;
        }
        const inputRows = node.inputIds
          .map(id => rowMap.get(id))
          .filter((r): r is number => r !== undefined);
        if (inputRows.length === 0) {
          rowMap.set(node.id, 0);
          continue;
        }
        const minR = Math.min(...inputRows);
        const maxR = Math.max(...inputRows);
        rowMap.set(node.id, (minR + maxR) / 2);
      }
    }
  }

  // 2-hop downstream median re-sort (INPUT_ORDER = AUTO only). After the barycentre pass each
  // input's row is approximately at its IMMEDIATE consumer's row (1-hop), but a path through an
  // intermediate gate like a NOT still crosses other horizontal corridors (e.g. HBLK -> not_7
  // -> and_8 puts HBLK at not_7's row; if and_8 sits elsewhere the not_7->and_8 vertical
  // crosses unrelated wires). Re-sorting the input column by the 2-hop median of consumer ranks
  // (consumer's consumer) instead places HBLK at and_8's row, straightening the full path.
  //
  // IMPORTANT: this re-sorts the input column and re-assigns INTEGER ranks 0..n in the new
  // order — `assignCoordinates` then space-packs them at uniform `sep()` spacing. So the input
  // column's Y RANGE stays bounded to the original (height never balloons), unlike a direct
  // placement at the raw 2-hop Y, which put START/EXT_ALARM at extreme Ys (4400+) because their
  // 2-hop consumers were bottom outputs (the AUTO reordering placed them at the bottom). Only
  // the SORT ORDER changes; uniform spacing holds; invariants stay satisfied.
  if (opts.inputOrder === 'AUTO' && inputGroup.length > 4) {
    // Successor map (node -> nodes it feeds into), excluding feedback edges (output sinks).
    const isFeedback = (id: string) => nodes.get(id)?.kind === 'output';
    const succ = new Map<string, string[]>();
    for (const n of nodes.values()) {
      for (const id of n.inputIds) {
        if (isFeedback(id)) continue;
        const a = succ.get(id) ?? []; a.push(n.id); succ.set(id, a);
      }
    }
    const med = (vals: number[]) => { const s = vals.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Two-hop downstream median: use the rank of the consumer's consumer (NOT the consumer
      // itself) as the sort key. For an input feeding through an intermediate single-input
      // gate like a NOT, the 1-hop barycentre places the input at the NOT's row, but the
      // NOT then feeds a gate elsewhere — the input's straightest target is the consumer's
      // CONSUMER's row (e.g. HBLK -> not_7 -> and_8 places HBLK at and_8's row). For inputs
      // feeding multi-input gates directly, 1-hop and 2-hop converge.
      //
      // Bounded: clamp each input's movement to within ±ceil(n/3) ranks of its barycentre
      // position. Unbounded 2-hop occasionally throws an input clean across the column when
      // its 2-hop consumer (an output or a far-flung gate) sits at an extreme — the new row
      // then crosses un-related wires (RESET jumping from bottom to top in Shared Intermediates
      // overlapped a COMPARE fan-out trunk). Clamping preserves the barycentre's overall
      // structure while letting 2-hop nudge inputs toward straighter positions locally.
      const twoHop = (id: string): number => {
        const cons = succ.get(id) ?? [];
        if (cons.length === 0) return rowMap.get(id) ?? 0;
        const ranks: number[] = [];
        for (const c of cons) {
          const cc = succ.get(c);
          if (cc && cc.length > 0) ranks.push(...cc.map(x => rowMap.get(x) ?? 0));
          else ranks.push(rowMap.get(c) ?? 0);
        }
        return med(ranks);
      };
      const bary = new Map<string, number>();
      for (const n of inputGroup) bary.set(n.id, rowMap.get(n.id) ?? 0);
      const n = inputGroup.length;
      const maxMove = Math.max(1, Math.ceil(n / 3));
      const clampedTwoHop = (id: string): number => {
        const b = bary.get(id) ?? 0;
        const t = twoHop(id);
        return Math.max(b - maxMove, Math.min(b + maxMove, t));
      };
      // Stable tie-broken sort by the clamped 2-hop median; preserve the existing order on ties.
      inputGroup.sort((a, b) => (clampedTwoHop(a.id) - clampedTwoHop(b.id)) || ((bary.get(a.id) ?? 0) - (bary.get(b.id) ?? 0)));
      for (let i = 0; i < inputGroup.length; i++) rowMap.set(inputGroup[i].id, i);

      // Fan-in contiguity: keep each gate's single-consumer inputs contiguous, so a large fan-in
      // aligns straight to its ports instead of being split — and doglegged around — by an input
      // that feeds a DIFFERENT gate (the split is what tangles a big OR/AND and crowds its wires).
      // Group single-consumer inputs by consumer; order the blocks by their members' average rank
      // (keeps each block roughly where it was); within a block keep rank/Y order so it still matches
      // the gate's ascending-Y port assignment. Multi-consumer inputs stay singletons (they serve
      // several gates legitimately). Then reassign contiguous ranks.
      const soleConsumer = new Map<string, string>();
      for (const inp of inputGroup) {
        const cs = [...nodes.values()].filter(nd => nd.inputIds.includes(inp.id));
        if (cs.length === 1) soleConsumer.set(inp.id, cs[0].id);
      }
      const rankOf = (inp: FlatNode) => rowMap.get(inp.id) ?? 0;
      const blocks = new Map<string, FlatNode[]>();
      for (const inp of inputGroup) {
        const key = soleConsumer.get(inp.id) ?? inp.id;
        (blocks.get(key) ?? blocks.set(key, []).get(key)!).push(inp);
      }
      const ordered = [...blocks.values()].sort((a, b) =>
        a.reduce((s, x) => s + rankOf(x), 0) / a.length - b.reduce((s, x) => s + rankOf(x), 0) / b.length);
      for (const blk of ordered) blk.sort((a, b) => rankOf(a) - rankOf(b));
      ordered.flat().forEach((inp, i) => rowMap.set(inp.id, i));

    // Multi-layer crossing minimisation: order the DERIVED layers (gates + outputs) by BOTH sides,
    // not just their inputs. Alternate a down-sweep (rank = mean of input ranks) with an up-sweep
    // (rank = mean of consumer ranks) over layers 1..maxDepth, iterating; the input layer stays
    // fixed. The up-sweep is the half that was missing: a gate driving outputs far below it (a
    // cascade OR feeding bottom outputs) is pulled toward its consumers, so its output wires don't
    // dogleg back across another gate's fan-out. Continuous ranks are fine — only the order is used.
    const meanRank = (ids: string[]): number | null => {
      const rs = ids.map(id => rowMap.get(id)).filter((r): r is number => r !== undefined);
      return rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null;
    };
    const succOf = new Map<string, string[]>();
    for (const nd of nodes.values()) for (const id of nd.inputIds) {
      if (nodes.get(id)?.kind === 'output') continue; // feedback edge, not a forward consumer
      (succOf.get(id) ?? succOf.set(id, []).get(id)!).push(nd.id);
    }
    for (let it = 0; it < 6; it++) {
      for (let depth = 1; depth <= maxDepth; depth++)
        for (const node of depthGroups.get(depth) ?? []) {
          // Side-balanced barycentre: the midpoint between the input barycentre and the consumer
          // barycentre (each SIDE weighted equally, regardless of how many edges it has). This pulls
          // a reconvergent gate — many inputs high, few outputs low — to the true middle so its
          // output wires don't dogleg back across another gate's fan-out, while a gate whose inputs
          // and consumers already align barely moves (so it doesn't dogleg its own fan-in). Outputs
          // have no consumers and keep their driver order.
          const inM = meanRank(node.inputIds), outM = meanRank(succOf.get(node.id) ?? []);
          const t = inM !== null && outM !== null ? (inM + outM) / 2 : inM ?? outM;
          if (t !== null) rowMap.set(node.id, t);
        }
    }
  }

  // crossmin candidate: replace the heuristic ranks with the crossing-minimised ordering (real
  // nodes only; the dummy pass below reserves lanes exactly as for the heuristic path).
  if (strategy === 'crossmin') {
    const cm = crossminOrder(nodes, maxDepth, opts);
    for (const [id, r] of cm) rowMap.set(id, r);
  }

  const layoutNodes: LayoutNode[] = [];
  const nodeMap = new Map<string, LayoutNode>();

  // OPTION COMPACTNESS scales spacing per axis. COMPACT_V / COMPACT tighten vertical (row)
  // spacing; COMPACT_H / COMPACT tighten horizontal (column) spacing; SPACIOUS loosens
  // vertical. Tighter spacing still respects the minimum gaps enforced by the collision and
  // protected-zone passes, so it never causes overlaps.
  const cmp = opts.compactness;
  const vScale = opts.compactnessFactors ? opts.compactnessFactors[0]
    : cmp === 'COMPACT' || cmp === 'COMPACT_V' ? 0.7 : cmp === 'SPACIOUS' ? 1.35 : 1;
  const hScale = opts.compactnessFactors ? opts.compactnessFactors[1]
    : cmp === 'COMPACT' || cmp === 'COMPACT_H' ? 0.72 : 1;
  const rowSpacing = Math.round(ROW_SPACING * vScale / GRID) * GRID;
  const colSpacing = Math.round(COL_SPACING * hScale / GRID) * GRID;

  // Obstacle-aware placement: decompose every edge spanning more than one depth column into a
  // chain of thin DUMMY nodes (one per intermediate column), so the coordinate assignment reserves
  // a vertical lane for that wire and never drops a real gate into its straight path. The
  // ordering (rowMap) above is computed on REAL nodes only — dummies don't reorder gates; each
  // dummy is slotted at the row interpolated between the edge's endpoints (i.e. on the wire's
  // line). Dummies reserve space only: they are removed after placement and routing uses the
  // original edges through the now-clear lane.
  const dummyIds = new Set<string>();
  const restoreEdges: { node: FlatNode; inputIds: string[]; inputPorts?: (string | undefined)[] }[] = [];
  for (const c of [...nodes.values()]) {
    if (c.inputIds.length === 0) continue;
    let changed = false;
    const rc = rowMap.get(c.id) ?? 0;
    const newInputs = c.inputIds.map(sid => {
      const s = nodes.get(sid);
      if (!s || s.kind === 'output' || c.depth - s.depth <= 1) return sid; // short edge / feedback
      changed = true;
      const rs = rowMap.get(sid) ?? 0;
      let prev = sid;
      for (let d = s.depth + 1; d < c.depth; d++) {
        const did = uid('dummy');
        const node: FlatNode = { id: did, kind: 'gate', gateType: 'DUMMY', depth: d, inputIds: [prev] };
        nodes.set(did, node);
        rowMap.set(did, rs + ((rc - rs) * (d - s.depth)) / (c.depth - s.depth)); // on the edge line
        (depthGroups.get(d) ?? (depthGroups.set(d, []).get(d)!)).push(node);
        dummyIds.add(did);
        prev = did;
      }
      return prev;
    });
    if (changed) { restoreEdges.push({ node: c, inputIds: c.inputIds, inputPorts: c.inputPorts }); c.inputIds = newInputs; }
  }

  // ---- Priority-method coordinate assignment (spec: Coordinate Assignment) ----
  // Each node's vertical centre is aligned to the median of its neighbours on BOTH sides
  // (sources and consumers), keeping the per-column barycentre order. Replaces the old global
  // row-rank mapping, which spread nodes apart and ignored the consumer side.
  const assignedY = assignCoordinates(nodes, depthGroups, rowMap, maxDepth, rowSpacing, laneTight);

  // Dummies have done their job (reserving lanes) — restore the original edges and drop them so
  // geometry and routing see only real nodes, now placed clear of the long-edge lanes.
  for (const { node, inputIds, inputPorts } of restoreEdges) { node.inputIds = inputIds; node.inputPorts = inputPorts; }
  for (const id of dummyIds) nodes.delete(id);

  for (const node of nodes.values()) {
    const absY = assignedY.get(node.id) ?? PAD_Y;
    const absX = PAD_X + node.depth * colSpacing;

    let w: number, h: number;

    if (node.kind === 'input') {
      w = INPUT_LABEL_W;
      h = node.description ? 30 : 20;
      if (node.name && hasMathContent(node.name)) h = Math.max(h, 30);
      if (node.description && hasMathContent(node.description)) h = Math.max(h, 30);
      h = Math.ceil(h / 10) * 10;
      const outX = absX + w + INPUT_STUB;
      const outY = absY + h / 2;

      const ln: LayoutNode = {
        id: node.id, gateType: 'INPUT', label: node.label,
        name: node.name, description: node.description,
        absX, absY, width: w + INPUT_STUB, height: h,
        inputs: [], outputs: [{ name: 'out', absX: outX, absY: outY }],
        depth: node.depth,
      };
      layoutNodes.push(ln);
      nodeMap.set(node.id, ln);
    } else if (node.kind === 'output') {
      w = OUTPUT_LABEL_W;
      h = node.description ? 30 : 20;
      if (node.name && hasMathContent(node.name)) h = Math.max(h, 30);
      if (node.description && hasMathContent(node.description)) h = Math.max(h, 30);
      h = Math.ceil(h / 10) * 10;
      let inX = absX;
      const inY = absY + h / 2;
      let bubbledInput = false;

      // Mark bubbled input (BUBBLES mode: NOT feeding into output)
      if (node.invertedInputs && node.invertedInputs.has(0)) {
        bubbledInput = true;
        inX -= BUBBLE_R * 2;
      }

      const ln: LayoutNode = {
        id: node.id, gateType: 'OUTPUT', label: node.label,
        name: node.name, description: node.description,
        absX, absY, width: w + OUTPUT_STUB, height: h,
        inputs: [{ name: 'in', absX: inX, absY: inY, bubbled: bubbledInput || undefined }], outputs: [],
        depth: node.depth,
      };
      layoutNodes.push(ln);
      nodeMap.set(node.id, ln);
    } else if (node.gateType === 'NOT') {
      w = NOT_GATE_TOTAL_W;
      h = NOT_GATE_H;

      const ln: LayoutNode = {
        id: node.id, gateType: 'NOT', label: node.label,
        absX, absY, width: w, height: h,
        inputs: [{ name: 'in_0', absX: absX, absY: absY + h / 2 }],
        outputs: [{ name: 'out', absX: absX + w, absY: absY + h / 2 }],
        depth: node.depth,
      };
      layoutNodes.push(ln);
      nodeMap.set(node.id, ln);
    } else if (node.blockType) {
      const bt = node.blockType;
      ({ w, h } = bt === 'FB' ? fbDims(node) : blockSize(bt));
      const right = absX + w;
      let inputs: LayoutPort[];
      let outputs: LayoutPort[];
      if (bt === 'FB') {
        // Generic block: evenly-spaced input ports (labelled) on the left, one output port per
        // referenced .name on the right (default OUT). Ports are re-aligned to sources later.
        const place = (count: number, x: number): LayoutPort[] =>
          Array.from({ length: count }, (_, i) => ({
            name: '', absX: x, absY: Math.round((absY + (h * (i + 1)) / (count + 1)) / GRID) * GRID,
          }));
        const used = [...(node.usedPorts ?? new Set<string>())];
        if (used.length === 0) used.push('OUT');
        inputs = place(node.inputIds.length, absX);
        inputs.forEach((p, i) => { p.name = `in_${i}`; p.label = node.inputLabels?.[i]; });
        outputs = place(used.length, right);
        outputs.forEach((p, i) => { p.name = used[i]; p.label = used[i] === 'OUT' ? undefined : used[i]; });
      } else if (bt === 'SR') {
        inputs = [
          { name: 'S', absX, absY: absY + 15 },
          { name: 'R', absX, absY: absY + 40 },
        ];
        const used = node.usedPorts ?? new Set(['Q']);
        outputs = [];
        if (used.has('Q')) outputs.push({ name: 'Q', absX: right, absY: absY + 15 });
        if (used.has('NQ')) outputs.push({ name: 'NQ', absX: right, absY: absY + 40 });
        if (outputs.length === 0) outputs.push({ name: 'Q', absX: right, absY: absY + h / 2 });
      } else if (bt === 'COMPARE') {
        inputs = [
          { name: '+', absX, absY: absY + 15 },
          { name: '-', absX, absY: absY + 35 },
        ];
        outputs = [{ name: 'OUT', absX: right, absY: absY + h / 2 }];
      } else {
        // TIMER, RISING, FALLING — single input/output, centred.
        inputs = [{ name: 'in', absX, absY: absY + h / 2 }];
        outputs = [{ name: 'OUT', absX: right, absY: absY + h / 2 }];
      }
      const ln: LayoutNode = {
        id: node.id, gateType: bt, label: node.label,
        name: node.name, description: node.description,
        absX, absY, width: w, height: h,
        inputs, outputs, depth: node.depth,
        blockType: bt, params: node.params,
      };
      layoutNodes.push(ln);
      nodeMap.set(node.id, ln);
    } else {
      const numInputs = node.inputIds.length || 2;
      const isMultiInput = numInputs > 2;
      const useBars = opts.gateInputStyle === 'BARS' && numInputs > 2;

      const gGap = gateGap(node);
      if (useBars) {
        h = AND_GATE_H_BASE;
        w = isMultiInput ? GATE_W_MULTI : GATE_W;
      } else {
        h = gateBodyHeight(numInputs, gGap);
        w = isMultiInput ? GATE_W_MULTI : GATE_W;
      }

      const inputs: LayoutPort[] = [];
      if (useBars) {
        // First two inputs: normal ports on the gate body at 1/3 and 2/3 height.
        const portSpacing = Math.round(h / 3 / GRID) * GRID;
        for (let i = 0; i < Math.min(2, numInputs); i++) {
          const portY = absY + (i + 1) * portSpacing;
          inputs.push({ name: `in_${i}`, absX: absX, absY: portY });
        }
        // Bar-tapped inputs (3rd+): evenly distribute across the full gate body height.
        // Each tap's port sits at the bar X (absX - 12 per spec), so wires connect there
        // and the stub from bar to gate body is rendered as part of the gate symbol.
        const barX = absX - INPUT_BAR_OFFSET;
        const barCount = numInputs - 2;
        const barSpan = h - GRID * 2; // 1 grid inset top and bottom
        for (let i = 0; i < barCount; i++) {
          const portY = Math.round((absY + GRID + (barSpan * (i + 0.5)) / barCount) / GRID) * GRID;
          inputs.push({ name: `in_${i + 2}`, absX: barX, absY: portY });
        }
      } else {
      for (let i = 0; i < numInputs; i++) {
        const portY = gateInputPortY(absY, i, gGap);
        inputs.push({ name: `in_${i}`, absX: absX, absY: portY });
      }
    }

    // Inversion bubbles for multi-input gates are assigned in a later pass (see "Inversion bubble
    // port assignment"), once source-Y ordering — which decides source→port mapping — is final.

      // Apply per-port style overrides
      const styleMap = new Map<string, 'CIRCLE' | 'SQUARE'>();
      for (const m of portMeta) {
        if (m.property === 'Style') styleMap.set(m.identifier, m.value.toUpperCase() as 'CIRCLE' | 'SQUARE');
      }

      const gateCenterY = Math.round((absY + h / 2) / GRID) * GRID;
      const outputs: LayoutPort[] = [{ name: 'out', absX: absX + w, absY: gateCenterY }];

      // Mark bubbled output (BUBBLES mode) and shift output port right for bubble
      if (node.bubbledOutput) {
        outputs[0].bubbledOutput = true;
        outputs[0].absX += BUBBLE_R * 2;
      }

      const ln: LayoutNode = {
        id: node.id, gateType: node.gateType ?? 'AND', label: node.label,
        name: node.name, description: node.description,
        absX, absY, width: w, height: h,
        inputs, outputs, depth: node.depth,
        barsMode: useBars ? true : undefined,
      };
      layoutNodes.push(ln);
      nodeMap.set(node.id, ln);
    }
  }

  // OPTION COLUMN_SPACING = ADAPTIVE: replace the fixed COL_SPACING pitch with a per-gap width sized
  // to each column's content. The gap between column d-1 and d must hold column d's fan-in dogleg
  // channels (nested at FANIN spacing), a gate-clearance turn at the gate, and a MIN_DOGLEG on the
  // source side — so gap = GATE_CLEARANCE + MIN_DOGLEG + (maxInDegree-1)*FANIN + slack. In-degree is
  // an upper bound on dogleg channels (straight inputs need none), so the estimate is conservative:
  // it only ever narrows relative to the uniform pitch and never cramps a fan-in. Shift is uniform
  // per column, so ports move with their node; runs before routing and label placement.
  if (opts.columnSpacing === 'ADAPTIVE') {
    const CLEAR = 20, FANIN = 15, SLACK = 30;
    const colWidth: number[] = [], colX: number[] = [PAD_X];
    for (let d = 0; d <= maxDepth; d++) {
      let w = 0;
      for (const n of layoutNodes) if (n.depth === d) w = Math.max(w, n.width);
      colWidth[d] = w;
    }
    for (let d = 1; d <= maxDepth; d++) {
      let indeg = 0;
      for (const n of layoutNodes) if (n.depth === d && n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT') indeg = Math.max(indeg, n.inputs.length);
      const gap = Math.round((CLEAR + MIN_DOGLEG + Math.max(0, indeg - 1) * FANIN + SLACK) / GRID) * GRID;
      colX[d] = Math.min(colX[d - 1] + colWidth[d - 1] + gap, PAD_X + d * colSpacing); // never wider than uniform
    }
    for (const n of layoutNodes) {
      const dx = colX[n.depth] - n.absX;
      if (dx === 0) continue;
      n.absX += dx;
      for (const p of n.inputs) p.absX += dx;
      for (const p of n.outputs) p.absX += dx;
    }
  }

  for (const gateNode of layoutNodes) {
    if (gateNode.gateType === 'INPUT' || gateNode.gateType === 'OUTPUT') continue;
    const gateTop = gateNode.absY;
    const gateBottom = gateNode.absY + gateNode.height;
    const gateRight = gateNode.absX;

    for (const inputNode of layoutNodes) {
      if (inputNode.gateType !== 'INPUT') continue;
      if (inputNode.absX >= gateRight) continue;

      const inputBottom = inputNode.absY + inputNode.height;
      if (inputBottom > gateTop && inputNode.absY < gateBottom && inputNode.absY < gateTop + 5) {
        const shift = Math.round((inputBottom - gateTop + 5) / GRID) * GRID;
        gateNode.absY += shift;
        for (const port of gateNode.inputs) port.absY += shift;
        for (const port of gateNode.outputs) port.absY += shift;
      }
    }
  }

  // Position a gate's output port(s): a single output at the body centre; a multi-output block
  // (e.g. a generic FB) spreads its outputs evenly over the body. Used wherever the body is moved
  // or resized, so outputs stay placed (and downstream consumers, processed in depth order, align).
  const recenterOutputs = (g: LayoutNode) => {
    const no = g.outputs.length;
    if (no <= 1) {
      if (g.outputs[0]) g.outputs[0].absY = Math.round((g.absY + g.height / 2) / GRID) * GRID;
      return;
    }
    // FB outputs sit a fixed 40 apart (the output-stack gap) so the output nodes they drive
    // line up straight; other multi-output blocks just spread evenly.
    const gap = g.blockType === 'FB' ? 40 : Math.max(MIN_PORT_GAP, (g.height - 20) / no);
    const start = g.absY + g.height / 2 - ((no - 1) * gap) / 2;
    g.outputs.forEach((p, i) => { p.absY = Math.round((start + i * gap) / GRID) * GRID; });
  };

  // Align each single-input gate (e.g. NOT) so its input sits exactly on its source's output
  // Y — a straight wire. Processed in depth order so a chain of NOTs aligns left-to-right.
  // Run again AFTER the multi-input height/position passes below, because those move the
  // source gates and would otherwise leave a single-input gate stranded at a stale Y (which
  // makes its output collide with, and detour around, a neighbour in the next column).
  const singleInputGates = Array.from(nodes.values())
    .filter(n => n.kind === 'gate' && n.inputIds.length === 1)
    .sort((a, b) => a.depth - b.depth);
  const alignSingleInputGates = () => {
    for (const node of singleInputGates) {
      const gateNode = nodeMap.get(node.id);
      if (!gateNode || gateNode.inputs.length !== 1) continue;
      const sourceNode = nodeMap.get(node.inputIds[0]);
      if (!sourceNode || sourceNode.outputs.length === 0) continue;
      const sourceOutputY = Math.round(sourceNode.outputs[0].absY / GRID) * GRID;
      const offsetY = sourceOutputY - gateNode.inputs[0].absY;
      gateNode.absY = Math.round((gateNode.absY + offsetY) / GRID) * GRID;
      gateNode.inputs[0].absY = sourceOutputY;
      recenterOutputs(gateNode);
    }
  };
  alignSingleInputGates();

  for (const node of nodes.values()) {
    if (node.kind !== 'output') continue;
    const outputNode = nodeMap.get(node.id);
    if (!outputNode || node.inputIds.length === 0) continue;
    const sourceId = node.inputIds[0];
    const sourceNode = nodeMap.get(sourceId);
    if (!sourceNode || sourceNode.outputs.length === 0) continue;
    const sourceOutputY = Math.round(sourceNode.outputs[0].absY / GRID) * GRID;
    outputNode.inputs[0].absY = sourceOutputY;
    outputNode.absY = Math.round((sourceOutputY - outputNode.height / 2) / GRID) * GRID;
  }

  // ── Phase: gate placement. Every multi-input AND/OR gate is sized by PORT COUNT only (label-aware
  // gap) and slid to the position that minimises sub-MIN_DOGLEG jogs on its input wires — one
  // principled min-jog fit, whether the gate is fed by inputs or by other gates. Processed in depth
  // order so each gate sees its drivers already placed. The body is never grown to span far-apart
  // sources; such wires read as clean Z-routes. (NOT gates and blocks are aligned by their own
  // passes; outputs/inputs by their placement phases.)
  {
    const placeGate = (node: FlatNode) => {
      const gateNode = nodeMap.get(node.id);
      if (!gateNode || gateNode.inputs.length < 2) return;
      const gap = gateGap(node);
      const h = gateBodyHeight(node.inputIds.length, gap);
      const srcYs = node.inputIds
        .map(id => nodeMap.get(id)?.outputs[0]?.absY)
        .filter((y): y is number => y !== undefined && Number.isFinite(y))
        .sort((a, b) => a - b);
      if (srcYs.length < 2) return;
      const cen = (srcYs[0] + srcYs[srcYs.length - 1]) / 2;
      let bestTop = gateNode.absY, bestSc = Infinity;
      for (let top = srcYs[0] - h; top <= srcYs[srcYs.length - 1] + GRID; top += GRID) {
        let sc = Math.abs(top + h / 2 - cen) * 0.001;
        for (let k = 0; k < srcYs.length; k++) {
          const d = Math.abs(srcYs[k] - gateInputPortY(top, k, gap));
          if (d >= 1 && d < MIN_DOGLEG) sc += 1000;
          sc += d * 0.1;
        }
        if (sc < bestSc) { bestSc = sc; bestTop = Math.round(top / GRID) * GRID; }
      }
      gateNode.absY = bestTop;
      gateNode.height = h;
      for (let k = 0; k < gateNode.inputs.length; k++) {
        gateNode.inputs[k].absY = Math.round(gateInputPortY(bestTop, k, gap) / GRID) * GRID;
      }
      recenterOutputs(gateNode);
    };
    for (const node of [...nodes.values()]
      .filter(n => n.kind === 'gate' && n.gateType && n.gateType !== 'NOT' && n.inputIds.length >= 2)
      .sort((a, b) => a.depth - b.depth)) placeGate(node);
  }

  // (Output nodes are placed in the single "Phase: output placement" pass after all gate moves.)

  // Resolve gate-gate overlaps at the same depth column by pushing the lower
  // gate down so their bounding boxes no longer intersect.
  for (let pass = 0; pass < 5; pass++) {
    let anyOverlap = false;
    // Gates vs gates
    for (let i = 0; i < layoutNodes.length; i++) {
      const a = layoutNodes[i];
      if (a.gateType === 'INPUT' || a.gateType === 'OUTPUT') continue;
      for (let j = i + 1; j < layoutNodes.length; j++) {
        const b = layoutNodes[j];
        if (b.gateType === 'INPUT' || b.gateType === 'OUTPUT') continue;
        if (a.depth !== b.depth) continue;
        const xOverlap = Math.min(a.absX + a.width, b.absX + b.width) - Math.max(a.absX, b.absX);
        if (xOverlap <= 0) continue;
        const yOverlap = Math.min(a.absY + a.height, b.absY + b.height) - Math.max(a.absY, b.absY);
        if (yOverlap <= 0) continue;
        const shift = Math.round((yOverlap + MIN_PORT_GAP) / GRID) * GRID;
        if (a.absY < b.absY) {
          b.absY += shift;
          for (const port of b.inputs) port.absY += shift;
          for (const port of b.outputs) port.absY += shift;
        } else {
          a.absY += shift;
          for (const port of a.inputs) port.absY += shift;
          for (const port of a.outputs) port.absY += shift;
        }
        anyOverlap = true;
      }
    }
    // Gates vs outputs
    for (const node of layoutNodes) {
      if (node.gateType === 'INPUT') continue;
      if (node.gateType !== 'OUTPUT') continue;
      for (const gate of layoutNodes) {
        if (gate.gateType === 'INPUT' || gate.gateType === 'OUTPUT') continue;
        if (node.depth !== gate.depth) continue;
        const xOverlap = Math.min(node.absX + node.width, gate.absX + gate.width) - Math.max(node.absX, gate.absX);
        if (xOverlap <= 0) continue;
        const yOverlap = Math.min(node.absY + node.height, gate.absY + gate.height) - Math.max(node.absY, gate.absY);
        if (yOverlap <= 0) continue;
        const shift = Math.round((yOverlap + MIN_PORT_GAP) / GRID) * GRID;
        if (gate.absY < node.absY) {
          node.absY += shift;
          node.inputs[0].absY += shift;
        } else {
          gate.absY += shift;
          for (const port of gate.inputs) port.absY += shift;
          for (const port of gate.outputs) port.absY += shift;
        }
        anyOverlap = true;
      }
    }
    if (!anyOverlap) break;
  }

  // The collision pass above is the last thing that moves multi-input gates; re-align every
  // single-input gate (NOT) to its now-final source so it stays straight-through and out of
  // the next column's horizontal corridor (e.g. a NOT feeding an output mustn't sit in the
  // straight path of another gate's output wire).
  alignSingleInputGates();

  // (Output placement is done in a single pass after all gate moves — see "Phase: output
  // placement" below.)

  // Place feedback input ports. A feedback input has no left-hand source (it loops back from
  // an output), so the source-alignment passes above leave its port unset (non-finite). The
  // loop-back enters from whichever side it approaches: if the consumer sits ABOVE its
  // feedback driver the loop comes over the top (top port → fewer crossings), otherwise it
  // comes under (bottom port). Place the port on that side, expanding the gate body if needed.
  const feedbackPorts = new Set<typeof layoutNodes[number]['inputs'][number]>();
  for (const ln of layoutNodes) {
    const fb = ln.inputs.filter(p => !Number.isFinite(p.absY));
    for (const p of fb) feedbackPorts.add(p);
    if (fb.length === 0) continue;
    const real = ln.inputs.filter(p => Number.isFinite(p.absY));
    const fbOut = nodes.get(ln.id)?.inputIds.find(id => nodeMap.get(id)?.gateType === 'OUTPUT');
    const driverId = fbOut ? nodes.get(fbOut)?.inputIds[0] : undefined;
    const driver = driverId ? nodeMap.get(driverId) : undefined;
    const overTop = !!driver && (ln.absY + ln.height / 2) < (driver.absY + driver.height / 2);
    if (overTop) {
      let y = real.length ? Math.min(...real.map(p => p.absY)) : ln.absY + ln.height - PORT_SPACING / 2;
      for (const p of fb) { y = Math.round((y - PORT_SPACING) / GRID) * GRID; p.absY = y; p.absX = ln.absX; }
      const topEdge = y - PORT_SPACING;
      if (topEdge < ln.absY) { const grow = Math.ceil((ln.absY - topEdge) / GRID) * GRID; ln.absY -= grow; ln.height += grow; }
    } else {
      let y = real.length ? Math.max(...real.map(p => p.absY)) : ln.absY + PORT_SPACING / 2;
      for (const p of fb) { y = Math.round((y + PORT_SPACING) / GRID) * GRID; p.absY = y; p.absX = ln.absX; }
      const bottom = y + PORT_SPACING;
      if (bottom > ln.absY + ln.height) ln.height = Math.ceil((bottom - ln.absY) / GRID) * GRID;
    }
    if (ln.outputs[0]) ln.outputs[0].absY = Math.round((ln.absY + ln.height / 2) / GRID) * GRID;
  }

  // Snap all node and port positions to the grid BEFORE routing. This guarantees that
  // an aligned source/dest pair has exactly equal Y, so the router takes the clean
  // straight-line fast-path instead of a 1px dogleg (which the router can otherwise
  // mis-handle). Done before the OR curve-tap pass so curve taps are not re-snapped.
  for (const n of layoutNodes) {
    n.absX = Math.round(n.absX / GRID) * GRID;
    n.absY = Math.round(n.absY / GRID) * GRID;
    for (const p of [...n.inputs, ...n.outputs]) {
      p.absX = Math.round(p.absX / GRID) * GRID;
      p.absY = Math.round(p.absY / GRID) * GRID;
    }
  }

  // ── Phase: dogleg cleanup. Gate placement MINIMISES sub-MIN_DOGLEG jogs, but a few can survive a
  // placement compromise — a multi-consumer input that cannot sit on every gate's port, or a body
  // nudged by the protected zone. This phase enforces the clean-wire rule: for any input port within
  // MIN_DOGLEG of (but not on) its source, shift the WHOLE gate to align one port without creating a
  // new small jog elsewhere; only if no such shift exists, nudge the single port (keeping its
  // PORT_SPACING gap to neighbours). Feedback ports have no left-hand source and are skipped.
  const isSmall = (d: number) => Math.abs(d) >= 0.5 && Math.abs(d) < MIN_DOGLEG;
  for (const node of nodes.values()) {
    if (node.inputIds.length === 0) continue;
    const ln = nodeMap.get(node.id);
    if (!ln || ln.inputs.length === 0) continue;
    const srcYs = node.inputIds
      .map(id => nodeMap.get(id)?.outputs[0]?.absY)
      .filter((y): y is number => y !== undefined)
      .sort((a, b) => a - b);
    // Exclude feedback ports — they have no left-hand source, so pairing them to a real
    // source Y by sorted index mis-detects a phantom dogleg and shifts the whole gate.
    const ports = [...ln.inputs].filter(p => !feedbackPorts.has(p)).sort((a, b) => a.absY - b.absY);
    const n = Math.min(ports.length, srcYs.length);
    const diffs = () => ports.map((p, i) => (i < n ? p.absY - srcYs[i] : 0));
    if (!diffs().some(isSmall)) continue;

    // Candidate whole-gate shifts: the offset that would align each currently-small port.
    const candidates = diffs().map((d, i) => (isSmall(d) ? -d : null)).filter((x): x is number => x !== null);
    let applied = false;
    for (const delta of candidates) {
      if (!Number.isInteger(delta / GRID)) continue;
      const after = ports.map((p, i) => (i < n ? p.absY + delta - srcYs[i] : 0));
      if (after.some(isSmall)) continue; // would still leave a small jog somewhere
      ln.absY += delta;
      for (const p of ln.inputs) p.absY += delta;
      for (const p of ln.outputs) p.absY += delta;
      applied = true;
      break;
    }
    if (applied) continue;

    // Fallback: nudge an individual port onto its source, but never closer than
    // PORT_SPACING to a neighbour (so we don't trade a dogleg for a too-tight port gap).
    for (let i = 0; i < n; i++) {
      const port = ports[i];
      const want = srcYs[i];
      if (!isSmall(port.absY - want) || !Number.isInteger(want / GRID)) continue;
      const prevY = i > 0 ? ports[i - 1].absY : -Infinity;
      const nextY = i < ports.length - 1 ? ports[i + 1].absY : Infinity;
      const insideBody = ln.gateType === 'OUTPUT' || (want > ln.absY && want < ln.absY + ln.height);
      if (want - prevY >= PORT_SPACING - 0.5 && nextY - want >= PORT_SPACING - 0.5 && insideBody) {
        port.absY = want;
        if (ln.gateType === 'OUTPUT') ln.absY = Math.round((want - ln.height / 2) / GRID) * GRID;
      }
    }
  }

  // Helper: the output Y of a driver's port `portName` (or its first output) — used by the
  // input/output placement phases to align a wire's far end to its driver.
  const blkSrcY = (srcId: string, portName?: string): number | undefined => {
    const s = nodeMap.get(srcId);
    if (!s) return undefined;
    return ((portName ? s.outputs.find(o => o.name === portName) : undefined) ?? s.outputs[0])?.absY;
  };
  // Protected zone: keep a minimum vertical gap between adjacent gate bodies in a column. The
  // alignment passes pull gates toward their sources, which can jam two gates that share an
  // input right up against each other (e.g. an AND and a NOT both reading the same signal).
  // Push the lower gate down to open the gap. The push is at least MIN_DOGLEG so the gate's
  // (now slightly offset) wires read as clean Z-routes rather than small jogs — and this runs
  // after the dogleg-killer so it is not pulled back. Done before routing so wires are fresh.
  for (const d of new Set(layoutNodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT').map(n => n.depth))) {
    const col = layoutNodes
      .filter(n => n.depth === d && n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT')
      .sort((a, b) => a.absY - b.absY);
    for (let i = 1; i < col.length; i++) {
      const gap = col[i].absY - (col[i - 1].absY + col[i - 1].height);
      if (gap < MIN_PORT_GAP - 0.5) {
        const dy = Math.round(Math.max(MIN_PORT_GAP - gap, MIN_DOGLEG) / GRID) * GRID;
        col[i].absY += dy;
        for (const p of col[i].inputs) p.absY += dy;
        for (const p of col[i].outputs) p.absY += dy;
      }
    }
  }

  // ── Phase: input placement. Snap each single-consumer INPUT onto the port row of the gate it
  // feeds, so its wire is straight (the gate is already port-count-sized and positioned). Process
  // each input column top-to-bottom, cascading to keep label-safe spacing; a multi-consumer input
  // can't sit on one gate's port so it keeps its swept position.
  {
    const consumerCount = new Map<string, number>();
    const consumerOf = new Map<string, string>();
    for (const nd of nodes.values()) for (const id of nd.inputIds) {
      consumerCount.set(id, (consumerCount.get(id) ?? 0) + 1);
      if (!consumerOf.has(id)) consumerOf.set(id, nd.id);
    }
    // The port Y that input `id` maps to on its consumer gate: gates connect sources to ports in
    // ascending source-Y order, so input rank r (by current source Y) -> the r-th port by Y.
    const targetPortY = (id: string): number | undefined => {
      const consumerId = consumerOf.get(id);
      const cFlat = consumerId ? nodes.get(consumerId) : undefined;
      const cNode = consumerId ? nodeMap.get(consumerId) : undefined;
      // Only align to AND/OR gate ports (uniform gap). Blocks (COMPARE/TIMER/...) and BARS gates
      // have their own fixed/asymmetric port layouts, and NOT has a single input.
      if (!cFlat || !cNode || (cFlat.gateType !== 'AND' && cFlat.gateType !== 'OR') || cNode.barsMode || cNode.inputs.length < 2) return undefined;
      const ranked = cFlat.inputIds
        .map(sid => ({ sid, y: nodeMap.get(sid)?.outputs[0]?.absY }))
        .filter((e): e is { sid: string; y: number } => e.y !== undefined)
        .sort((a, b) => a.y - b.y);
      const rank = ranked.findIndex(e => e.sid === id);
      if (rank < 0) return undefined;
      const portsByY = [...cNode.inputs].sort((a, b) => a.absY - b.absY);
      return portsByY[rank]?.absY;
    };
    const LABEL_GAP = 30;
    const cols = new Map<number, LayoutNode[]>();
    for (const ln of layoutNodes) {
      if (ln.gateType !== 'INPUT') continue;
      (cols.get(ln.absX) ?? cols.set(ln.absX, []).get(ln.absX)!).push(ln);
    }
    for (const col of cols.values()) {
      col.sort((a, b) => a.absY - b.absY);
      // Snap each single-consumer input onto its gate port — but only if the slot is clear of its
      // neighbours (so we never collide a snapped input with another input). Non-snappable inputs
      // keep their swept position.
      for (const ln of col) {
        if (consumerCount.get(ln.id) !== 1) continue;
        const want = targetPortY(ln.id);
        if (want === undefined) continue;
        const y = Math.round(want / GRID) * GRID;
        if (col.some(o => o !== ln && Math.abs(o.outputs[0]!.absY - y) < LABEL_GAP - 0.5)) continue;
        const d = y - (ln.outputs[0]?.absY ?? ln.absY);
        ln.absY += d;
        for (const p of ln.outputs) p.absY += d;
      }
    }
  }

  // ── Phase: output placement (single pass, runs after every gate move so it sees final driver
  // positions). Order each output column (AUTO by source Y, else declaration), then place each
  // output at its driver's output Y — a straight wire where the column allows, otherwise pushed
  // down to a clean >= MIN_DOGLEG below the output above. Subsumes the earlier align / snap /
  // de-overlap output passes.
  {
    const declIndex = new Map<string, number>();
    let di = 0;
    for (const node of nodes.values()) if (node.kind === 'output') declIndex.set(node.id, di++);
    const sourceY = (o: LayoutNode) => {
      const fn = nodes.get(o.id);
      const sy = fn ? blkSrcY(fn.inputIds[0], fn.inputPorts?.[0]) : undefined;
      return sy !== undefined ? Math.round(sy / GRID) * GRID : o.absY + o.height / 2;
    };
    const sourceDepth = (o: LayoutNode) => {
      const srcId = nodes.get(o.id)?.inputIds[0];
      return srcId ? nodes.get(srcId)?.depth ?? 0 : 0;
    };
    const cols = new Map<number, LayoutNode[]>();
    for (const n of layoutNodes) {
      if (n.gateType !== 'OUTPUT') continue;
      (cols.get(n.absX) ?? cols.set(n.absX, []).get(n.absX)!).push(n);
    }
    const minGap = 40; // centre-to-centre clearance between stacked output labels
    for (const outs of cols.values()) {
      // AUTO orders by source Y (deeper source wins a tie so its short wire stays straight); else
      // declaration order.
      outs.sort((a, b) =>
        opts.outputOrder === 'AUTO'
          ? sourceY(a) - sourceY(b) || sourceDepth(b) - sourceDepth(a) || declIndex.get(a.id)! - declIndex.get(b.id)!
          : declIndex.get(a.id)! - declIndex.get(b.id)!);
      let prevCenter = -Infinity;
      for (const o of outs) {
        if (!o.inputs[0]) continue;
        const want = sourceY(o);
        let center = Math.max(want, prevCenter + minGap);
        if (center - want > 0 && center - want < MIN_DOGLEG) center = want + MIN_DOGLEG;
        center = Math.round(center / GRID) * GRID;
        o.absY = Math.round((center - o.height / 2) / GRID) * GRID;
        o.inputs[0].absY = center;
        prevCenter = center;
      }
    }
  }

  // ---- Inversion bubble port assignment (BUBBLES mode) ----
  // Input ports connect to their sources in ascending source-Y order (the wire router's rule),
  // so an inverted input's bubble must follow its SIGNAL to whatever port that source lands on —
  // not a fixed input index. Assigning by index put the bubble on the wrong port whenever the
  // gate's inputs were reordered (e.g. `... AND NOT HBLK` with INPUT_ORDER = AUTO).
  for (const node of nodes.values()) {
    if (!node.invertedInputs || node.invertedInputs.size === 0) continue;
    const gate = nodeMap.get(node.id);
    if (!gate || gate.gateType === 'OUTPUT' || gate.inputs.length === 0) continue;
    const order = node.inputIds.map((id, i) => ({ i, y: blkSrcY(id, node.inputPorts?.[i]) ?? Infinity }));
    if (gate.gateType === 'AND' || gate.gateType === 'OR') order.sort((a, b) => a.y - b.y);
    order.forEach((e, rank) => {
      const port = gate.inputs[Math.min(rank, gate.inputs.length - 1)];
      if (port && node.invertedInputs!.has(e.i)) {
        port.bubbled = true;
        port.absX -= BUBBLE_R * 2;
      }
    });
  }

  // ---- Generic FB block: attach each input's label to the port its source lands on ----
  // (Inputs map to ports in ascending source-Y order, so the declared label list is permuted.)
  for (const node of nodes.values()) {
    if (node.blockType !== 'FB') continue;
    const gate = nodeMap.get(node.id);
    if (!gate) continue;
    const order = node.inputIds.map((id, i) => ({ i, y: blkSrcY(id, node.inputPorts?.[i]) ?? Infinity }));
    order.sort((a, b) => a.y - b.y);
    order.forEach((e, rank) => { if (gate.inputs[rank]) gate.inputs[rank].label = node.inputLabels?.[e.i]; });

    // Pull each output port onto its single consuming output node so the wire runs straight
    // (the output nodes are already placed by the AUTO stack + output-snap above).
    for (const port of gate.outputs) {
      const consumers = layoutNodes.filter(o => o.gateType === 'OUTPUT' &&
        nodes.get(o.id)?.inputIds[0] === node.id &&
        (nodes.get(o.id)?.inputPorts?.[0] ?? 'OUT') === port.name && o.inputs[0]);
      if (consumers.length === 1) port.absY = consumers[0].inputs[0].absY;
    }

    // Scale the box to ENCOMPASS its ports (each already sitting on its connection), grid-aligned,
    // so it grows with the input/output counts without forcing any wire into a jog/dogleg.
    const ys = [...gate.inputs, ...gate.outputs].map(p => p.absY);
    if (ys.length) {
      // Pad clears the router's vertical gate buffer (GATE_BUFFER_MIN_Y) so the top/bottom ports'
      // wires don't get nudged off their Y on the way out of the box.
      const pad = 30;
      const top = Math.floor((Math.min(...ys) - pad) / GRID) * GRID;
      const bottom = Math.ceil((Math.max(...ys) + pad) / GRID) * GRID;
      gate.absY = top;
      gate.height = bottom - top;
    }
  }

  // Keep same-column block bodies from touching. The FB encompass pass above grows each block's box
  // symmetrically around its ports, which can consume the vertical gap `sep()` reserved between two
  // adjacent blocks (their grown boxes meet — 50P1/50Q1 stacked body-to-body). This runs BEFORE
  // routing, so pushing a block (and its ports) down to restore a clean gap simply lets its wires
  // route to the new position — no wire is disturbed. Only blocks that actually overlap move, and
  // only downward, so a column without the problem is untouched.
  {
    const MIN_BLOCK_GAP = 20;
    const byCol = new Map<number, LayoutNode[]>();
    for (const n of layoutNodes) if (n.blockType) {
      const a = byCol.get(n.absX); if (a) a.push(n); else byCol.set(n.absX, [n]);
    }
    for (const col of byCol.values()) {
      if (col.length < 2) continue;
      col.sort((a, b) => a.absY - b.absY);
      for (let i = 1; i < col.length; i++) {
        const prev = col[i - 1], cur = col[i];
        const need = prev.absY + prev.height + MIN_BLOCK_GAP;
        if (cur.absY < need) {
          const dy = Math.ceil((need - cur.absY) / GRID) * GRID;
          cur.absY += dy;
          for (const p of cur.inputs) p.absY += dy;
          for (const p of cur.outputs) p.absY += dy;
        }
      }
    }
  }

  // OR gate input ports tap the concave left curve. Done as a final pass so it uses
  // the gate's final height and each port's final (aligned) Y. The bbox, output port
  // and port Y positions stay on the grid; only the input-port X follows the curve.
  // Bubbled inputs shift left by BUBBLE_R*2 so the bubble's inner edge meets the curve.
  for (const gateNode of layoutNodes) {
    if (gateNode.gateType !== 'OR') continue;
    for (let i = 0; i < gateNode.inputs.length; i++) {
      const port = gateNode.inputs[i];
      if (gateNode.barsMode && i >= 2) continue; // bar-tap ports stay on the bar
      const localY = port.absY - gateNode.absY;
      const tapX = gateNode.absX + orCurveTapX(gateNode.height, localY);
      port.absX = port.bubbled ? tapX - BUBBLE_R * 2 : tapX;
    }
  }

  return { nodes, intermediateLabels, layoutNodes, nodeMap };
}

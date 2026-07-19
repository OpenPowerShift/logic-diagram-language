import type { Diagram, PortMeta, RenderOptions } from '../parser/ast.js';
import { DEFAULT_OPTIONS, resolveOptions } from '../parser/ast.js';
import { hasMathContent } from './math-renderer.js';
import { routeWireAStar, type GateObstacle, type RoutedSegment } from './astar-router.js';
import { orCurveTapX } from './gates.js';
import { buildGraph, type FlatNode } from './graph.js';

import type {
  LayoutPort, LayoutNode, LayoutWire, LayoutJunction, LayoutLabel, LayoutResult, WireCrossing,
} from './layout/types.js';
export type { LayoutPort, LayoutNode, LayoutWire, LayoutJunction, LayoutLabel, LayoutResult, WireCrossing };
import {
  GATE_W, INPUT_BAR_OFFSET, GATE_W_MULTI, AND_GATE_H_BASE, PORT_SPACING, BUBBLE_R,
  NOT_GATE_TOTAL_W, NOT_GATE_H, INPUT_LABEL_W, OUTPUT_LABEL_W, INPUT_STUB, OUTPUT_STUB, COL_SPACING, ROW_SPACING, PAD_X, PAD_Y, MIN_PORT_GAP, MIN_DOGLEG, MIN_WIRE_SPACING,
  GRID, } from './layout/types.js';
import { findWireCrossings } from './layout/crossings.js';
export { findWireCrossings };
import { symmetriseSmallGates } from './layout/symmetry.js';
import { crossminOrder } from './layout/crossmin.js';
import { placeNetLabels, assignLeaderTargets } from './layout/labels.js';
import { assignCoordinates } from './layout/placement.js';
import {
  resetId, uid, naturalCompare, gateBodyHeight, gateInputPortY, gateGap, fbDims, blockSize,
} from './layout/geometry.js';

// Priority-method vertical coordinate assignment (Sugiyama/Tagawa style). Each column keeps
// its fixed order (the barycentre ordering); we then alternate downward (align to sources)
// and upward (align to consumers) sweeps. In each sweep a node is moved toward the median of
// its neighbours on that side, but it may not displace a neighbour of higher-or-equal
// priority (priority = degree on the sweep side); lower-priority neighbours are pushed to keep
// the minimum gap. Returns each node's top-left Y (grid-snapped, normalised to PAD_Y).


// Public entry: lay the diagram out with the input ORDERING that renders the fewest crossings. Each
// candidate strategy is a full, independent layout (layoutOnce rebuilds from scratch), and we keep
// whichever measures fewer crossings on the REAL geometry. 'heuristic' is always a candidate, so we
// can never render worse than before; 'crossmin' is tried only when 'heuristic' isn't already clean
// (the common case), keeping cost ~1x. Smarter candidates can be added later — each only ever helps.
export function layoutDiagram(diagram: Diagram, portMeta: PortMeta[] = [], options?: RenderOptions): LayoutResult {
  // Candidates span two independent dimensions: ordering ('heuristic' | 'crossmin') and long-edge
  // lane packing (loose | tight — see assignCoordinates `laneTight`). Each is a full independent
  // layout; we keep the best on MEASURED geometry, ranked lexicographically by: fewest sub-min
  // doglegs, then fewest crossings, then fewest bends, then shortest. The loose-heuristic layout is
  // always a candidate and is always dogleg-free, so the winner can never have more doglegs or
  // crossings than today — tight only wins when it genuinely removes a crossing or collapses a void
  // (shorter height) without cost. Ties keep the earlier (loose) candidate, so diagrams without long
  // edges stay byte-identical.
  const subMinDoglegs = (l: LayoutResult) => {
    let c = 0;
    for (const w of l.wires) {
      if (w.feedback) continue;
      for (let i = 0; i < w.points.length - 1; i++) {
        const a = w.points[i], b = w.points[i + 1];
        if (Math.abs(a.x - b.x) < 0.5) { const len = Math.abs(a.y - b.y); if (len >= 0.5 && len < MIN_DOGLEG - 0.01) c++; }
      }
    }
    return c;
  };
  const cr = (l: LayoutResult) => findWireCrossings(l.wires, l.junctions).length;
  const bends = (l: LayoutResult) => l.wires.reduce((s, w) => s + Math.max(0, w.points.length - 2), 0);
  // Cross-net COINCIDENT parallel overlap: two different nets' same-orientation segments sharing an
  // axis line (co-linear) and overlapping along it — i.e. drawn on top of each other. This is the
  // wire-separation contract's worst failure (worse than a crossing): the routing passes refuse to
  // trade it for a crossing, so when a placement/ordering leaves two nets genuinely contending for
  // one channel an overlap can survive a single layout. Scoring it as the TOP-priority term makes
  // the candidate selection reject any ordering/strategy that overlaps in favour of one that doesn't
  // — so no single pass's all-or-nothing fallback can leak an overlap into the chosen layout when a
  // clean candidate exists. Backed by the invariants.spec "no cross-net overlapping parallel" test.
  const overlaps = (l: LayoutResult): number => {
    interface S { p: number; a0: number; a1: number; from: string; }
    const V: S[] = [], H: S[] = [];
    for (const w of l.wires) {
      if (w.feedback) continue;
      for (let i = 0; i < w.points.length - 1; i++) {
        const a = w.points[i], b = w.points[i + 1];
        if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) >= 0.5) V.push({ p: a.x, a0: Math.min(a.y, b.y), a1: Math.max(a.y, b.y), from: w.fromId });
        else if (Math.abs(a.y - b.y) < 0.5 && Math.abs(a.x - b.x) >= 0.5) H.push({ p: a.y, a0: Math.min(a.x, b.x), a1: Math.max(a.x, b.x), from: w.fromId });
      }
    }
    let c = 0;
    for (const set of [V, H]) for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) {
      const a = set[i], b = set[j];
      if (a.from === b.from || Math.abs(a.p - b.p) >= 0.5) continue;   // different net, same axis line
      if (Math.min(a.a1, b.a1) - Math.max(a.a0, b.a0) >= GRID) c++;    // co-linear overlap (matches the invariant)
    }
    return c;
  };
  // Cross-net gate/block BODY intrusion: a wire segment (not entering that node) running through or
  // along a non-endpoint gate/block body. Uses the FULL body rect (no inset), so it also catches a
  // wire grazing the body's edge — a straight pass-through drawn along a block's border reads as part
  // of the block outline. A* can pick such a graze when it is the fewest-crossing route (the body
  // graze is not itself a crossing), so scoring it lets the candidate selection prefer a layout that
  // routes clear of the body when one exists. Ranked just below overlaps (both are "a wire drawn on
  // top of something it must stay clear of").
  const bodyIntrusions = (l: LayoutResult): number => {
    const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
    let c = 0;
    for (const w of l.wires) {
      if (w.feedback) continue;
      for (let i = 0; i < w.points.length - 1; i++) {
        const a = w.points[i], b = w.points[i + 1];
        const xm = Math.min(a.x, b.x), xM = Math.max(a.x, b.x), ym = Math.min(a.y, b.y), yM = Math.max(a.y, b.y);
        for (const g of gates) {
          if (g.id === w.fromId || g.id === w.toId) continue;   // legitimately enters this node
          // Real overlap with the body rect, edges included (so an on-edge graze counts).
          if (xM > g.absX + 0.5 && g.absX + g.width > xm + 0.5 && yM > g.absY - 0.5 && g.absY + g.height > ym - 0.5) c++;
        }
      }
    }
    return c;
  };
  const score = (l: LayoutResult): number[] => [overlaps(l), bodyIntrusions(l), subMinDoglegs(l), cr(l), bends(l), l.height];
  const better = (l: LayoutResult, b: LayoutResult) => {
    const sl = score(l), sb = score(b);
    for (let i = 0; i < sl.length; i++) if (sl[i] !== sb[i]) return sl[i] < sb[i];
    return false;                                                 // tie → keep the earlier candidate
  };

  let best = layoutOnce(diagram, portMeta, options, 'heuristic', false);
  const consider = (l: LayoutResult) => { if (better(l, best)) best = l; };
  consider(layoutOnce(diagram, portMeta, options, 'heuristic', true));   // lane-tight variant (collapses voids)
  // Reach for the crossmin candidates when the current best is not already clean — it still has
  // crossings, or (rarer) carries a cross-net overlap or a gate-body intrusion a different ordering
  // may avoid.
  if (cr(best) > 0 || overlaps(best) > 0 || bodyIntrusions(best) > 0) {
    consider(layoutOnce(diagram, portMeta, options, 'crossmin', false));
    consider(layoutOnce(diagram, portMeta, options, 'crossmin', true));
  }
  symmetriseSmallGates(best);                                    // cosmetic, validated post-pass
  placeNetLabels(best.labels, best.wires, best.nodes, best.junctions, options ?? DEFAULT_OPTIONS); // on FINAL geometry
  assignLeaderTargets(best);                                     // net-label leader targets on FINAL geometry
  return best;
}

// Assign each consumed-intermediate net label's leader target (leaderX/leaderY): the point on its OWN
// net nearest the label-box centre. The net is every wire driven by the label's node (all fan-out
// branches share `driverId`) PLUS that net's junction dots. Runs on the FINAL geometry — after EVERY
// wire-reshaping pass, including symmetriseSmallGates which moves small gates' fan-in channels after
// layoutOnce returns — so the OPTION WIRE_LABEL_LEADER connector always lands ON the wire it names
// (not the pre-reshape position). Uses a proper point-to-segment projection, robust to any segment
// orientation and to degenerate point-segments (junctions).
// Place each consumed-intermediate net label centred on its OWN net's run and clear of wires/bodies
// (see the leader in svg-renderer via OPTION WIRE_LABEL_LEADER). Runs on FINAL geometry — after every
// wire-reshaping pass INCLUDING symmetriseSmallGates (which moves small gates' fan-in channels after
// layoutOnce returns) — so a label is never left sitting on a wire the reshape moved under it.




// Cosmetic symmetry for small gates: for a ≤3-input gate with exactly one dogleg fan-in above the
// middle and one below (each a clean H–V–H), align their turn channels to a single X so the two
// doglegs mirror — a symmetric funnel, which reads much cleaner. Runs on the FINAL chosen layout, so
// it cannot flip the candidate choice; and every move is fully validated — kept only if it neither
// adds a crossing nor brings the moved wire within MIN_WIRE_SPACING of another net (else reverted),
// so it can never introduce a new problem.


// Candidate input ordering that MINIMISES crossings (Sugiyama step 2), built on its OWN local
// layered graph (real nodes + local dummy chains for long edges, so every edge joins adjacent layers
// and long-edge crossings are countable). Returns a per-layer rank for the REAL nodes only — the
// caller's existing dummy pass then reserves lanes as usual. Crossings are counted with PORT
// AWARENESS: an edge into a FIXED-PORT block (SR/timer/…) carries the block's declared port index, so
// a reversed source order counts as a crossing (this is what keeps SR S/R uncrossed); AND/OR ports
// follow source order (no internal cross). This is only ever a CANDIDATE — the caller keeps it only
// if it renders fewer crossings than the heuristic — so the combinatorial count need not be perfect.


function layoutOnce(diagram: Diagram, portMeta: PortMeta[] = [], options: RenderOptions | undefined, strategy: 'heuristic' | 'crossmin', laneTight = false): LayoutResult {
  resetId();

  const opts = options ?? DEFAULT_OPTIONS;

  // Phase 1 — build the flattened logic graph (semantic model) from the parsed AST.
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

  const wires: LayoutWire[] = [];
  const junctions: LayoutJunction[] = [];
  const junctionSet = new Set<string>();

  function addJunction(x: number, y: number) {
    const key = `${Math.round(x / GRID) * GRID},${Math.round(y / GRID) * GRID}`;
    if (!junctionSet.has(key)) {
      junctionSet.add(key);
      junctions.push({ x: Math.round(x / GRID) * GRID, y: Math.round(y / GRID) * GRID });
    }
  }

  const allObstacles: GateObstacle[] = layoutNodes.map(n => ({ x: n.absX, y: n.absY, w: n.width, h: n.height, id: n.id }));

  // Place each intermediate net label just above its driver's output, and register it as a
  // routing obstacle so the fan-out wires route around (not through) the text.
  const labels: LayoutLabel[] = [];
  const textW = (s?: string, size = 11) => (s ? s.length * size * 0.6 : 0);
  for (const il of intermediateLabels) {
    const driver = nodeMap.get(il.driverId);
    if (!driver) continue;
    const port = (il.port ? driver.outputs.find(o => o.name === il.port) : undefined) ?? driver.outputs[0];
    if (!port) continue;
    const w = Math.ceil((Math.max(textW(il.name, 11), textW(il.description, 9)) + 8) / GRID) * GRID;
    const lines = (il.name ? 1 : 0) + (il.description ? 1 : 0);
    const h = Math.ceil((lines * 13 + 6) / GRID) * GRID;
    const x = Math.round((port.absX + 6) / GRID) * GRID;     // just right of the output stub
    const y = Math.round((port.absY - h - 6) / GRID) * GRID;  // above the fan-out trunk
    labels.push({ x, y, width: w, height: h, anchorX: port.absX, anchorY: port.absY, driverId: il.driverId, name: il.name, description: il.description });
    allObstacles.push({ x, y, w, h, id: `label_${il.driverId}` });
  }

  const routedSegments: RoutedSegment[] = [];

  const canvasW = Math.max(...layoutNodes.map(n => n.absX + n.width), ...layoutNodes.map(n => n.outputs[0]?.absX ?? n.absX + n.width)) + 200;
  const canvasH = Math.max(...layoutNodes.map(n => n.absY + n.height)) + 200;

  // The output port a wire leaves from: a named port (SR .Q/.NQ) if the consumer selected one,
  // otherwise the source's first output.
  const sourcePort = (srcId: string, portName?: string): LayoutPort | undefined => {
    const src = nodeMap.get(srcId);
    if (!src) return undefined;
    return (portName ? src.outputs.find(o => o.name === portName) : undefined) ?? src.outputs[0];
  };

  // Build fan-out groups: destinations per (source, output port). Keyed `id::PORT` so a block
  // with two outputs (SR Q and NQ) routes each from its own port.
  const fanOutGroups = new Map<string, { toId: string; toPort: LayoutPort; toLayoutNode: LayoutNode; destIsGate: boolean }[]>();

  const wireRoutingOrder = Array.from(nodes.values()).sort((a, b) => a.depth - b.depth);
  for (const node of wireRoutingOrder) {
    if (node.inputIds.length === 0) continue;
    const toLayoutNode = nodeMap.get(node.id);
    if (!toLayoutNode) continue;

    let entries = node.inputIds.map((id, i) => ({ id, port: node.inputPorts?.[i] }));
    if (node.kind === 'gate' && (node.gateType === 'AND' || node.gateType === 'OR' || node.blockType === 'FB')) {
      entries = entries
        .map(e => ({ ...e, y: sourcePort(e.id, e.port)?.absY ?? Infinity }))
        .sort((a, b) => a.y - b.y);
    }

    for (let i = 0; i < entries.length; i++) {
      const { id: fromId, port } = entries[i];
      const toPortIdx = Math.min(i, toLayoutNode.inputs.length - 1);
      const toPort = toLayoutNode.inputs[toPortIdx];
      if (!toPort) continue;
      const destIsGate = node.kind === 'gate';
      const groupKey = `${fromId}::${port ?? ''}`;
      if (!fanOutGroups.has(groupKey)) fanOutGroups.set(groupKey, []);
      fanOutGroups.get(groupKey)!.push({ toId: node.id, toPort, toLayoutNode, destIsGate });
    }
  }

  // Route wires. Each destination is routed independently from the source output
  // port, which guarantees every consumer connects (including a source that feeds
  // both a gate and an output). Wires from the same source naturally overlap on a
  // shared horizontal "trunk" near the source (same-source crossings are cheap) and
  // diverge into separate channels; junction dots are added afterwards wherever
  // same-source wires form a T-intersection.
  for (const [groupKey, destinations] of fanOutGroups) {
    const sep = groupKey.lastIndexOf('::');
    const fromId = groupKey.slice(0, sep);
    const portName = groupKey.slice(sep + 2);
    const fromLayoutNode = nodeMap.get(fromId);
    const fromPort = sourcePort(fromId, portName || undefined);
    if (!fromLayoutNode || !fromPort) continue;
    const fx = fromPort.absX;
    const fy = fromPort.absY;

    // Route the destinations closest in Y to the source first, so the shared trunk
    // is established before farther branches need to find their channels.
    const ordered = [...destinations].sort(
      (a, b) => Math.abs(a.toPort.absY - fy) - Math.abs(b.toPort.absY - fy),
    );

    for (const dest of ordered) {
      const points = routeWireAStar(
        fx, fy, dest.toPort.absX, dest.toPort.absY,
        allObstacles,
        fromLayoutNode.absX, fromLayoutNode.absY,
        fromLayoutNode.width, fromLayoutNode.height,
        dest.toLayoutNode.absX, dest.toLayoutNode.absY,
        dest.toLayoutNode.width, dest.toLayoutNode.height,
        dest.destIsGate,
        routedSegments,
        canvasW, canvasH,
        fromId,
      );

      routedSegments.push({ points, fromId });
      wires.push({ id: uid('wire'), points, fromId, toId: dest.toId });
    }
  }

  // Gate-clearance helpers, shared by the channel track-assignment pass and the fan-in
  // nesting below. A vertical/horizontal run must stay GATE_CLEARANCE clear of every gate body.
  const GATE_CLEARANCE = 20;
  function vGateClear(x: number, y0: number, y1: number, skipId?: string): boolean {
    const yMin = Math.min(y0, y1), yMax = Math.max(y0, y1);
    for (const o of allObstacles) {
      if (o.id === skipId) continue;
      if (x > o.x - GATE_CLEARANCE && x < o.x + o.w + GATE_CLEARANCE &&
          yMax > o.y - 1 && yMin < o.y + o.h + 1) return false;
    }
    return true;
  }
  function hGateClear(y: number, x0: number, x1: number, skipId: string): boolean {
    const xMin = Math.min(x0, x1), xMax = Math.max(x0, x1);
    for (const o of allObstacles) {
      if (o.id === skipId) continue;
      if (y > o.y - 1 && y < o.y + o.h + 1 && xMax > o.x - 1 && xMin < o.x + o.w + 1) return false;
    }
    return true;
  }

  // ── Wire separation contract (single source of truth) ───────────────────────────────────────
  // A segment is "clear" only if it keeps >= MIN_WIRE_SPACING from every PARALLEL same-orientation
  // segment of a DIFFERENT net (both orientations); perpendicular crossings are fine (crossovers,
  // not crowding). EVERY wire-reshaping pass below (channel track assignment, fan-in nesting,
  // shared-trunk merge, output snap) validates its proposed geometry through this ONE contract
  // before committing, so no pass can silently override another's separation. (Gate-body clearance
  // is vGateClear/hGateClear.) Reads `wires` live, so it always reflects current geometry.
  const segCrowds = (x0: number, y0: number, x1: number, y1: number, skip: (w: LayoutWire) => boolean): boolean => {
    const horiz = Math.abs(y0 - y1) < 0.5;
    if (!horiz && Math.abs(x0 - x1) >= 0.5) return false; // only axis-aligned segments participate
    const perp = horiz ? y0 : x0;
    const aMin = horiz ? Math.min(x0, x1) : Math.min(y0, y1);
    const aMax = horiz ? Math.max(x0, x1) : Math.max(y0, y1);
    for (const w of wires) {
      if (skip(w)) continue;
      for (let i = 0; i < w.points.length - 1; i++) {
        const a = w.points[i], b = w.points[i + 1];
        const oHoriz = Math.abs(a.y - b.y) < 0.5;
        if (oHoriz !== horiz || (!oHoriz && Math.abs(a.x - b.x) >= 0.5) || (oHoriz && Math.abs(a.x - b.x) < 0.5)) continue;
        const oPerp = horiz ? a.y : a.x, dp = Math.abs(oPerp - perp);
        if (dp < 0.5 || dp >= MIN_WIRE_SPACING - 0.5) continue; // co-linear (overlap check elsewhere) or clear
        const oMin = horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
        const oMax = horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
        if (Math.min(aMax, oMax) - Math.max(aMin, oMin) > 0.5) return true; // parallel & overlapping & too close
      }
    }
    return false;
  };
  // A proposed wire (its point list) satisfies the contract iff none of its segments crowds another
  // net. `skip` excludes the wire being moved and any co-moved siblings (same source shares a trunk).
  const wireClear = (pts: { x: number; y: number }[], skip: (w: LayoutWire) => boolean): boolean => {
    for (let i = 0; i < pts.length - 1; i++)
      if (segCrowds(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, skip)) return false;
    return true;
  };

  // ── Channel track assignment ────────────────────────────────────────────────
  // Every wire that turns once (H–V–H) carries a single vertical segment living in the
  // inter-column channel between its two horizontal runs. Verticals that overlap in Y must
  // occupy distinct X "tracks" or they collide (the no-parallel-overlap invariant). A greedy
  // per-wire search can't resolve a *mutual* conflict — it never moves the other wire to make
  // room — so we assign tracks jointly: (1) collect the movable verticals, (2) group them into
  // channels by overlapping X-window, (3) interval-graph-colour each channel by Y so overlapping
  // cross-net verticals land on different tracks (same-source verticals may share a track — they
  // form a trunk), then (4) pick the track→X placement that minimises wire crossings, spreading
  // tracks across the channel's gate-clear window. All-or-nothing per channel and only for
  // channels that actually collide: a channel whose assignment can't be validated (gate in the
  // way, window too narrow) keeps its routed geometry, so we never trade a clean route for a
  // collision, and clean channels are left untouched.
  // A wire entering a gate input port must arrive with a horizontal run of at least
  // GATE_ENTRANCE, so the vertical turn sits clear of the gate body/curve and the wire visibly
  // enters horizontally rather than turning on the gate's edge (see spec: minimum gate entrance).
  const GATE_ENTRANCE = 20;
  interface Movable {
    w: LayoutWire; vi: number;
    aX: number; bX: number;         // left/right ends of run A / run B (the vertical's X-window)
    yA: number; yB: number;         // Y of run A (before V) and run B (after V)
    yTop: number; yBot: number;
    destIsGate: boolean;            // destination is a gate input port (entrance rule applies)
  }
  // The track pass adjusts a wire's single vertical (a clean H–V–H turn). It deliberately does NOT
  // touch multi-bend wires: their extra bends are obstacle detours, and sliding the approach vertical
  // of such a wire would just drag its entrance horizontal along a sibling's wire (trading a gate-hug
  // for a horizontal overlap). Those cases are congestion to solve at placement, not here.
  const movables: Movable[] = [];
  for (const w of wires) {
    if (w.feedback) continue;
    const p = w.points;
    let vi = -1, vcount = 0;
    for (let i = 0; i < p.length - 1; i++) {
      if (Math.abs(p[i].x - p[i + 1].x) < 0.5 && Math.abs(p[i].y - p[i + 1].y) >= GRID) { vi = i; vcount++; }
    }
    if (vcount !== 1 || vi <= 0 || vi + 2 >= p.length) continue;            // single clean H–V–H only
    if (Math.abs(p[vi - 1].y - p[vi].y) > 0.5) continue;                    // segment before V is horizontal
    if (Math.abs(p[vi + 1].y - p[vi + 2].y) > 0.5) continue;                // segment after V is horizontal
    const aX = p[vi - 1].x, bX = p[vi + 2].x;
    if (bX <= aX + 0.5) continue;                                          // left-to-right turns only
    const yA = p[vi].y, yB = p[vi + 1].y;
    const destNode = nodeMap.get(w.toId);
    const destIsGate = !!destNode && destNode.gateType !== 'INPUT' && destNode.gateType !== 'OUTPUT';
    movables.push({ w, vi, aX, bX, yA, yB, yTop: Math.min(yA, yB), yBot: Math.max(yA, yB), destIsGate });
  }

  // Fixed verticals: every vertical segment the track pass does NOT adjust (straight wires have
  // none; a multi-bend wire's non-tail verticals are pinned by the obstacles they detour around).
  // The pass treats these as occupied tracks so it keeps MIN_WIRE_SPACING clear of them — otherwise
  // a track can land 5px from a pinned vertical and read as a cluster. Only the specific adjustable
  // tail vertical of each movable is excluded (by wire id + segment index), not the whole wire.
  const movVi = new Map<string, number>();
  for (const m of movables) movVi.set(m.w.id, m.vi);
  const fixedVerts: { x: number; y0: number; y1: number; from: string }[] = [];
  for (const w of wires) {
    for (let i = 0; i < w.points.length - 1; i++) {
      if (movVi.get(w.id) === i) continue;                    // the adjustable tail vertical
      const a = w.points[i], b = w.points[i + 1];
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) >= GRID)
        fixedVerts.push({ x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), from: w.fromId });
    }
  }
  // Cross-net fixed verticals overlapping m's Y-span (excludes m's own source).
  const nearFixed = (m: Movable) => fixedVerts.filter(fv =>
    fv.from !== m.w.fromId && Math.min(m.yBot, fv.y1) - Math.max(m.yTop, fv.y0) > 0);

  const yOverlap = (a: Movable, b: Movable) => Math.min(a.yBot, b.yBot) - Math.max(a.yTop, b.yTop) >= GRID;
  const placeValid = (m: Movable, X: number) =>
    X >= m.aX - 0.5 && X <= m.bX + 0.5 &&
    vGateClear(X, m.yA, m.yB) && hGateClear(m.yA, m.aX, X, m.w.fromId) && hGateClear(m.yB, X, m.bX, m.w.toId);
  // Interior crossing between a horizontal run and another wire's vertical.
  const orthCross = (hx0: number, hx1: number, hy: number, vx: number, vy0: number, vy1: number) =>
    vx > Math.min(hx0, hx1) + 0.5 && vx < Math.max(hx0, hx1) - 0.5 &&
    hy > Math.min(vy0, vy1) + 0.5 && hy < Math.max(vy0, vy1) - 0.5;
  const pairCross = (m1: Movable, x1: number, m2: Movable, x2: number) => {
    if (m1.w.fromId === m2.w.fromId) return 0;                    // same source: shared trunk, not a crossing
    let c = 0;
    if (orthCross(m1.aX, x1, m1.yA, x2, m2.yA, m2.yB)) c++;
    if (orthCross(x1, m1.bX, m1.yB, x2, m2.yA, m2.yB)) c++;
    if (orthCross(m2.aX, x2, m2.yA, x1, m1.yA, m1.yB)) c++;
    if (orthCross(x2, m2.bX, m2.yB, x1, m1.yA, m1.yB)) c++;
    return c;
  };
  const SPREAD = 3 * GRID;                                        // preferred gap between cross-net tracks
  // Current X of each adjustable tail vertical (mutated as we place); every movable, whether or not
  // it is re-placed, acts as an obstacle at its current X. Working globally (no channel grouping)
  // means two verticals can never be blind to each other, so we can't reintroduce a collision.
  const curX = new Map<Movable, number>(movables.map(m => [m, m.w.points[m.vi].x]));
  const crossNet = (m: Movable) => movables.filter(o => o !== m && o.w.fromId !== m.w.fromId && yOverlap(o, m));

  // The wire's two horizontal runs (run A: yA over [aX,X]; run B: yB over [X,bX]) at a candidate X,
  // checked against other nets' horizontals via the shared contract. The vertical stays under curX
  // coordination above; this adds the horizontal half so the track pass honours the full contract.
  const runsCrowd = (m: Movable, X: number) => {
    const skip = (o: LayoutWire) => o.id === m.w.id || o.fromId === m.w.fromId;
    return segCrowds(m.aX, m.yA, X, m.yA, skip) || segCrowds(X, m.yB, m.bX, m.yB, skip);
  };

  // A movable violates if it hugs a gate (fails its own gate-clearance), has too short a gate
  // entrance, or runs within MIN_WIRE_SPACING of any cross-net vertical (fixed or another movable)
  // it overlaps in Y, or its horizontal runs crowd another net. Only violating movables are
  // re-placed; clean ones stay put (minimal churn).
  const crowded = (m: Movable, X: number) =>
    nearFixed(m).some(fv => Math.abs(fv.x - X) < MIN_WIRE_SPACING - 0.5) ||
    crossNet(m).some(o => Math.abs(curX.get(o)! - X) < MIN_WIRE_SPACING - 0.5) ||
    runsCrowd(m, X);
  const violates = (m: Movable) => {
    const X = curX.get(m)!;
    return !placeValid(m, X) || (m.destIsGate && m.bX - X < GATE_ENTRANCE - 0.5) || crowded(m, X);
  };

  // Candidate X's: grid positions in [aX, cap] that keep both runs gate-clear; a gate-bound vertical
  // is capped at bX-GATE_ENTRANCE so its horizontal entrance stays >= GATE_ENTRANCE.
  const candsFor = (m: Movable) => {
    const cands: number[] = [];
    const capX = m.destIsGate ? m.bX - GATE_ENTRANCE : m.bX;
    for (let x = Math.ceil(m.aX / GRID) * GRID; x <= Math.floor(capX / GRID) * GRID; x += GRID)
      if (placeValid(m, x)) cands.push(x);
    return cands;
  };

  // Place violating movables most-constrained-first. Each avoids exact overlap with every fixed
  // vertical and every other movable's current X, and is scored to keep MIN_WIRE_SPACING clear,
  // minimise crossings, and stay near its routed X.
  const toPlace = movables.filter(violates).map(m => ({ m, cands: candsFor(m) }))
    .sort((a, b) => a.cands.length - b.cands.length);
  for (const { m, cands } of toPlace) {
    const origX = curX.get(m)!;
    const fixedForM = nearFixed(m), others = crossNet(m);
    let bestX: number | null = null, bestCost = Infinity;
    for (const x of cands) {
      let bad = false, cost = Math.abs(x - origX);
      for (const fv of fixedForM) {
        const d = Math.abs(fv.x - x);
        if (d < 0.5) { bad = true; break; }                       // exact overlap with a pinned vertical
        if (d < MIN_WIRE_SPACING - 0.5) cost += 2000; else if (d < SPREAD) cost += 50;
      }
      if (bad) continue;
      for (const o of others) {
        const d = Math.abs(curX.get(o)! - x);
        if (d < 0.5) { bad = true; break; }                       // exact overlap with another track
        cost += pairCross(m, x, o, curX.get(o)!) * 100000;        // avoid new crossings above all
        if (d < MIN_WIRE_SPACING - 0.5) cost += 2000; else if (d < SPREAD) cost += 50;
      }
      if (bad) continue;
      if (runsCrowd(m, x)) cost += 2000;                          // horizontal half of the contract
      if (cost < bestCost) { bestCost = cost; bestX = x; }
    }
    if (bestX !== null) curX.set(m, bestX);                        // no valid slot → keep routed X
  }
  for (const m of movables) { m.w.points[m.vi].x = curX.get(m)!; m.w.points[m.vi + 1].x = curX.get(m)!; }

  // Nested fan-in channels: when several wires dogleg into the same gate, give each its own
  // vertical channel just left of the gate, evenly spaced (FANIN_SPACING) and nested so they
  // neither cross nor crowd. Inputs arriving from above and from below are nested
  // independently, with the most extreme source turning closest to the gate — the arrangement
  // that avoids crossings and reads symmetrically. EVERY incoming dogleg wire is reshaped to
  // a clean H–V–H through its channel (regardless of the shape A* produced), so congested
  // multi-input gates get straight nested fan-in instead of A*'s small jogs. The all-or-
  // nothing validation falls back to the existing geometry if any channel hits a gate body or
  // a non-fan-in wire, so a genuinely obstacle-routed input is never forced through a gate.
  const FANIN_SPACING = 15;
  const lastPt = (w: LayoutWire) => w.points[w.points.length - 1];
  // Total interior crossings among cross-net, non-feedback wires (mirrors findWireCrossings). Used
  // as the all-or-nothing guard around a group reshape so nesting can never trade a hug for a crossing.
  type LPoint = { x: number; y: number };
  const nestHit = (h1: LPoint, h2: LPoint, v1: LPoint, v2: LPoint) =>
    Math.abs(h1.y - h2.y) < 1 && Math.abs(v1.x - v2.x) < 1 &&
    h1.y > Math.min(v1.y, v2.y) - 1 && h1.y < Math.max(v1.y, v2.y) + 1 &&
    v1.x > Math.min(h1.x, h2.x) - 1 && v1.x < Math.max(h1.x, h2.x) + 1;
  const nestCross = () => {
    let c = 0;
    for (let i = 0; i < wires.length; i++)
      for (let j = i + 1; j < wires.length; j++) {
        const a = wires[i], b = wires[j];
        if (a.fromId === b.fromId || a.feedback || b.feedback) continue;
        for (let s = 0; s < a.points.length - 1; s++)
          for (let t = 0; t < b.points.length - 1; t++)
            if (nestHit(a.points[s], a.points[s + 1], b.points[t], b.points[t + 1]) ||
                nestHit(b.points[t], b.points[t + 1], a.points[s], a.points[s + 1])) c++;
      }
    return c;
  };
  // Interior crossings of ONE wire against all other cross-net wires (same rule as nestCross). When a
  // reshape moves a single wire and nothing else, its own crossing count is the exact whole-diagram
  // delta — so this O(N) check replaces the O(N^2) nestCross() inside per-wire move searches.
  const wireCross = (self: LayoutWire) => {
    if (self.feedback) return 0;
    let c = 0;
    for (const o of wires) {
      if (o === self || o.fromId === self.fromId || o.feedback) continue;
      for (let s = 0; s < self.points.length - 1; s++)
        for (let t = 0; t < o.points.length - 1; t++)
          if (nestHit(self.points[s], self.points[s + 1], o.points[t], o.points[t + 1]) ||
              nestHit(o.points[t], o.points[t + 1], self.points[s], self.points[s + 1])) c++;
    }
    return c;
  };
  for (const gate of layoutNodes) {
    if (gate.gateType === 'INPUT' || gate.gateType === 'OUTPUT') continue;
    const fanWires = wires.filter(w => w.toId === gate.id && Math.abs(w.points[0].y - lastPt(w).y) >= 1);
    if (fanWires.length < 2) continue;

    const above = fanWires.filter(w => w.points[0].y < lastPt(w).y);
    const below = fanWires.filter(w => w.points[0].y > lastPt(w).y);
    above.sort((a, b) => a.points[0].y - b.points[0].y); // topmost source first
    below.sort((a, b) => b.points[0].y - a.points[0].y); // bottommost source first

    // A reshaped channel is rejected if it would hit a gate body or overlap a wire from a
    // different source that is NOT part of this gate's nested fan-in (those are crossing-free
    // by construction). Rejected groups keep their original geometry.
    // Above and below groups are placed with an interleave offset (below shifts half a step
    // leftward) so their channels interleave and don't share the same X — without the offset,
    // above[0] and below[0] both map to gate.absX - GATE_CLEARANCE and overlap.
    const fanSet = new Set(fanWires);
    // Gate clearance + the shared wire-separation contract (both orientations). Co-reshaped
    // siblings and the same source are skipped; the mutually-distinct channel Xs and interleave
    // below keep the siblings themselves apart.
    const channelOk = (w: LayoutWire, channelX: number, srcX: number, srcY: number, portX: number, portY: number) => {
      if (!vGateClear(channelX, srcY, portY)) return false;
      if (!hGateClear(srcY, srcX, channelX, w.fromId)) return false;
      if (!hGateClear(portY, channelX, portX, w.toId)) return false;
      // Reject a channel that lands EXACTLY on another net's vertical (same X, overlapping Y).
      // wireClear/segCrowds deliberately ignore exact-collinear overlap ("overlap check elsewhere"),
      // so two gates sitting at the same X would otherwise nest their fan-in channels onto one line
      // (e.g. TRS and TRT both at x=875 -> both channels at 855). The leftward search then steps to a
      // distinct channel instead.
      const my0 = Math.min(srcY, portY), my1 = Math.max(srcY, portY);
      for (const o of wires) {
        if (o === w || o.fromId === w.fromId || fanSet.has(o)) continue;
        for (let i = 0; i < o.points.length - 1; i++) {
          const a = o.points[i], b = o.points[i + 1];
          if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.x - channelX) < 0.5 &&
              Math.min(my1, Math.max(a.y, b.y)) - Math.max(my0, Math.min(a.y, b.y)) >= GRID) return false;
        }
      }
      const reshaped = [{ x: srcX, y: srcY }, { x: channelX, y: srcY }, { x: channelX, y: portY }, { x: portX, y: portY }];
      return wireClear(reshaped, o => o === w || o.fromId === w.fromId || fanSet.has(o));
    };

    // All-or-nothing per group. For EACH wire, take the gate-most channel that validates by
    // SEARCHING leftward from its ideal (nested) X down to its min: a wire whose source-side run at
    // the near-gate channel would cross a gate body instead turns *before* that obstacle (a slid
    // channel), rather than the whole group bailing to A*'s detour. Channels stay >= MIN_WIRE_SPACING
    // apart (mutually distinct, nested order preserved). If any wire finds no valid channel the group
    // keeps its routed geometry; and the applied reshape is reverted whole if it adds any crossing,
    // so a robust fan-in is never traded for a new crossover.
    const place = (group: LayoutWire[], offset: number) => {
      const plan: { w: LayoutWire; cx: number; srcX: number; srcY: number; portX: number; portY: number }[] = [];
      const used: number[] = [];
      const groupMinX = Math.max(0, ...group.map(w => Math.round((w.points[0].x + MIN_DOGLEG) / GRID) * GRID));
      const room = gate.absX - GATE_CLEARANCE - groupMinX;
      const step = group.length > 1
        ? Math.max(GRID, Math.min(FANIN_SPACING, Math.floor(room / (group.length - 1) / GRID) * GRID))
        : FANIN_SPACING;
      const gateMost = Math.round((gate.absX - GATE_CLEARANCE) / GRID) * GRID;
      for (let i = 0; i < group.length; i++) {
        const w = group[i];
        const srcX = w.points[0].x, srcY = w.points[0].y;
        const e = lastPt(w), portX = e.x, portY = e.y;
        const ideal = Math.round((gate.absX - GATE_CLEARANCE - i * step - offset) / GRID) * GRID;
        const minX = Math.round((srcX + MIN_DOGLEG) / GRID) * GRID;
        let cx: number | null = null;
        for (let x = Math.min(ideal, gateMost); x >= minX; x -= GRID) {   // gate-most valid channel, sliding before obstacles
          if (used.some(u => Math.abs(u - x) < MIN_WIRE_SPACING - 0.5)) continue;
          if (channelOk(w, x, srcX, srcY, portX, portY)) { cx = x; break; }
        }
        if (cx === null) return;                                          // no valid channel → keep routed geometry
        used.push(cx);
        plan.push({ w, cx, srcX, srcY, portX, portY });
      }
      const saved = group.map(w => w.points.map(p => ({ x: p.x, y: p.y })));
      const before = nestCross();
      for (const { w, cx, srcX, srcY, portX, portY } of plan) {
        w.points = [{ x: srcX, y: srcY }, { x: cx, y: srcY }, { x: cx, y: portY }, { x: portX, y: portY }];
      }
      if (nestCross() > before) group.forEach((w, k) => { w.points = saved[k]; }); // never add a crossing
    };
    // Interleave above and below groups so their channels don't share the same X. Without
    // the half-step offset, above[0] and below[0] both map to gate.absX - GATE_CLEARANCE and
    // end up at the same channel — overlapping. Below shifts by step/2 leftward to interleave.
    const aboveStep = (() => {
      const aboveMinX = Math.max(0, ...above.map(w => Math.round((w.points[0].x + MIN_DOGLEG) / GRID) * GRID));
      const aboveRoom = gate.absX - GATE_CLEARANCE - aboveMinX;
      return above.length > 1 ? Math.max(GRID, Math.min(FANIN_SPACING, Math.floor(aboveRoom / (above.length - 1) / GRID) * GRID)) : FANIN_SPACING;
    })();
    place(above, 0);
    place(below, Math.round(aboveStep / 2 / GRID) * GRID);
  }

  // Obstacle-aware output placement. An output whose port Y lands inside the vertical shadow of a gate
  // its incoming wire must cross is forced either to detour around that gate (a down-and-up /
  // up-and-over that lands on unrelated wires' lines) OR to drive straight THROUGH the gate body (a
  // gate crossing — e.g. PSV02's LED/ICMS outputs cutting through the TRS gate under reconvergence).
  // Move such an output to the nearest Y clear of every gate shadow its wire crosses, and redraw the
  // wire as one clean H–V–H. It is applied only when a clear position + route exists that validates
  // through gate clearance, the separation contract, sibling-output spacing, a legal dogleg, and a
  // no-new-crossing guard — otherwise fully reverted. So it can only ever remove a detour or a gate
  // crossing and can never introduce a crossing, crowd, overlap, or sub-min dogleg. Running before the
  // entrance pass frees any straight input the detour was blocking (the entrance pass straightens it).
  {
    const outGates = layoutNodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
    const bendsOf = (pts: { x: number; y: number }[]) => {
      let c = 0;
      for (let i = 1; i < pts.length - 1; i++)
        if ((Math.abs(pts[i - 1].y - pts[i].y) < 0.5) !== (Math.abs(pts[i].y - pts[i + 1].y) < 0.5)) c++;
      return c;
    };
    // Does any of the wire's segments cut through a gate body that is not its own endpoint?
    const crossesGate = (w: LayoutWire) => {
      for (let i = 0; i < w.points.length - 1; i++) {
        const a = w.points[i], b = w.points[i + 1];
        const xm = Math.min(a.x, b.x), xM = Math.max(a.x, b.x), ym = Math.min(a.y, b.y), yM = Math.max(a.y, b.y);
        for (const g of outGates) {
          if (g.id === w.fromId || g.id === w.toId) continue;
          if (xM > g.absX + 1 && g.absX + g.width - 1 > xm && yM > g.absY + 1 && g.absY + g.height - 1 > ym) return true;
        }
      }
      return false;
    };
    for (const O of layoutNodes) {
      if (O.gateType !== 'OUTPUT' || !O.inputs[0]) continue;
      const w = wires.find(x => x.toId === O.id && !x.feedback);
      // Act on a detour (>2 bends) OR a wire that cuts through a gate body; a clean approach is left alone.
      if (!w || w.points.length < 4 || (bendsOf(w.points) <= 2 && !crossesGate(w))) continue;
      const sx = w.points[0].x, sy = w.points[0].y, ox = O.inputs[0].absX, oy = O.inputs[0].absY;
      const spanL = Math.min(sx, ox) + 1, spanR = Math.max(sx, ox) - 1;
      const crossing = outGates.filter(g => g.id !== w.fromId && g.absX + g.width > spanL && g.absX < spanR);
      const yClear = (ny: number) => crossing.every(g => ny <= g.absY - 1 || ny >= g.absY + g.height + 1);
      if (yClear(oy)) continue;                                             // output not actually in a shadow
      const sibClear = (ny: number) => layoutNodes.every(s => s === O || s.gateType !== 'OUTPUT' ||
        s.absX !== O.absX || Math.abs((s.absY + s.height / 2) - ny) >= MIN_PORT_GAP - 0.5);
      const before = nestCross();
      let done = false;
      for (let d = GRID; d <= 500 && !done; d += GRID) {                    // nearest clear Y first (above or below)
        for (const ny of [oy - d, oy + d]) {
          if (ny < 0 || !yClear(ny) || !sibClear(ny)) continue;
          const jog = Math.abs(ny - sy);
          if (jog >= 0.5 && jog < MIN_DOGLEG) continue;                     // would be a sub-min dogleg
          for (let tapX = Math.round((sx + MIN_DOGLEG) / GRID) * GRID; tapX <= ox - GATE_ENTRANCE; tapX += GRID) {
            const route = [{ x: sx, y: sy }, { x: tapX, y: sy }, { x: tapX, y: ny }, { x: ox, y: ny }]
              .filter((p, i, a) => i === 0 || Math.abs(p.x - a[i - 1].x) >= 0.5 || Math.abs(p.y - a[i - 1].y) >= 0.5);
            const skip = (o: LayoutWire) => o === w || o.fromId === w.fromId;
            if (!vGateClear(tapX, sy, ny) || !hGateClear(sy, sx, tapX, w.fromId) ||
                !hGateClear(ny, tapX, ox, w.toId) || !wireClear(route, skip)) continue;
            const savedPts = w.points, savedOutY = O.absY, savedPortY = O.inputs[0].absY;
            w.points = route; O.inputs[0].absY = ny; O.absY = ny - O.height / 2;
            if (nestCross() > before) { w.points = savedPts; O.absY = savedOutY; O.inputs[0].absY = savedPortY; continue; }
            done = true; break;
          }
          if (done) break;
        }
      }
    }
  }

  // Un-wrap a single-consumer INPUT that wraps a block to reach its gate port (mirror of the output
  // placement above). A free input — exactly one consumer — feeds one port of a gate, but a sibling
  // block that also feeds that gate (an SR seal-in latch / sub-OR) sits in the horizontal span between
  // them, occupying the input's straight-line Y. The A* router is then forced up-and-over (or through)
  // that block, landing its wire across the block's own I/O wires (e.g. CTR3 → PSV03, wrapped over the
  // seal-in SR, crossing SR.Q→OR and OR→SR). Move the input's SOURCE Y to the near outer edge of that
  // shadow so a clean gate-clear H–V–H enters the fixed port from the correct side. Because only this
  // one wire moves, its own crossing count (wireCross, O(N)) is the exact whole-diagram delta; the move
  // is kept only if that STRICTLY drops and the route validates (gate clearance, separation contract,
  // sibling-input spacing, legal dogleg), reverted otherwise. So it can only ever remove a wrap
  // crossing and never introduces a crossing, crowd, overlap, or sub-min dogleg.
  {
    const fanout = new Map<string, number>();
    for (const w of wires) if (!w.feedback) fanout.set(w.fromId, (fanout.get(w.fromId) ?? 0) + 1);
    for (const S of layoutNodes) {
      if (S.gateType !== 'INPUT' || !S.outputs[0]) continue;
      if ((fanout.get(S.id) ?? 0) !== 1) continue;                          // single-consumer input only
      const w = wires.find(x => x.fromId === S.id && !x.feedback);
      if (!w || w.points.length < 4) continue;                             // a straight/one-bend input is already clean
      const before = wireCross(w);
      if (before === 0) continue;                                          // only act on an input wire that crosses
      const dest = nodeMap.get(w.toId);
      if (!dest || dest.gateType === 'INPUT' || dest.gateType === 'OUTPUT') continue;
      const sx = w.points[0].x, port = lastPt(w), px = port.x, py = port.y;
      const sibClear = (sy: number) => layoutNodes.every(s => s === S || s.gateType !== 'INPUT' ||
        s.absX !== S.absX || Math.abs((s.absY + s.height / 2) - sy) >= MIN_PORT_GAP - 0.5);
      const savedPts = w.points, savedSY = S.absY, savedOutY = S.outputs[0].absY;
      // Search source Ys nearest the port outward; keep the FEWEST-crossing clean route (a partial
      // un-wrap that still clips a sibling wire, e.g. lands on the block's other input, is not the goal —
      // the fully-clear position just past that wire is). Only touch `w`, so wireCross is the exact delta.
      let best: { pts: { x: number; y: number }[]; sy: number; cross: number } | null = null;
      let done = false;
      for (let d = GRID; d <= 500 && !done; d += GRID) {                    // source Y nearest the port first, above or below
        for (const sy of [py - d, py + d]) {
          if (sy < 0 || !sibClear(sy)) continue;
          const jog = Math.abs(sy - py);
          if (jog >= 0.5 && jog < MIN_DOGLEG) continue;                     // would be a sub-min dogleg
          for (let tapX = Math.round((px - GATE_ENTRANCE) / GRID) * GRID; tapX > sx + MIN_DOGLEG; tapX -= GRID) {
            const route = [{ x: sx, y: sy }, { x: tapX, y: sy }, { x: tapX, y: py }, { x: px, y: py }]
              .filter((p, i, a) => i === 0 || Math.abs(p.x - a[i - 1].x) >= 0.5 || Math.abs(p.y - a[i - 1].y) >= 0.5);
            const skip = (o: LayoutWire) => o === w || o.fromId === w.fromId;
            if (!vGateClear(tapX, sy, py) || !hGateClear(sy, sx, tapX, w.fromId) ||
                !hGateClear(py, tapX, px, w.toId) || !wireClear(route, skip)) continue;
            w.points = route;
            const c = wireCross(w);
            w.points = savedPts;
            if (c < (best?.cross ?? before)) best = { pts: route, sy, cross: c };
            if (c === 0) { done = true; break; }                            // fully clean — take it (nearest wins)
          }
          if (done) break;
        }
      }
      if (best && best.cross < before) { w.points = best.pts; S.outputs[0].absY = best.sy; S.absY = best.sy - S.height / 2; }
    }
  }

  // Straighten gratuitous sub-MIN_DOGLEG jogs: a small vertical step between two horizontal runs
  // is collapsed when the far run can slide onto the near run's Y with the span clear of gate
  // bodies (the obstacle-aware placement lanes can leave such a jog where the route had room to
  // run straight). Conservative: only when gate-clear, validated against the dogleg invariant.
  for (const w of wires) {
    if (w.feedback) continue;
    let changed = true;
    while (changed) {
      changed = false;
      const p = w.points;
      for (let k = 1; k + 3 < p.length; k++) {                    // need run B AND a segment after it (so p[k+2] is never the terminal port)
        if (Math.abs(p[k].x - p[k + 1].x) > 0.5) continue;        // segment k vertical
        const len = Math.abs(p[k].y - p[k + 1].y);
        if (len < 0.5 || len >= MIN_DOGLEG) continue;             // small jog only
        if (Math.abs(p[k - 1].y - p[k].y) > 0.5) continue;        // run A horizontal
        if (Math.abs(p[k + 1].y - p[k + 2].y) > 0.5) continue;    // run B horizontal
        const yA = p[k].y;
        const spanClear = hGateClear(yA, p[k + 1].x, p[k + 2].x, w.toId) && hGateClear(yA, p[k + 1].x, p[k + 2].x, w.fromId);
        const nextOk = vGateClear(p[k + 2].x, yA, p[k + 3].y, w.toId);   // skip the destination gate: a port approach is meant to be near it
        if (!spanClear || !nextOk) continue;
        p[k + 1].y = yA; p[k + 2].y = yA; // slide run B onto run A's Y
        w.points = p.filter((pt, i) => i === 0 || Math.abs(pt.x - p[i - 1].x) >= 0.5 || Math.abs(pt.y - p[i - 1].y) >= 0.5);
        changed = true;
        break;
      }
    }
  }

  // Feedback (loop-back) wires. A source that is an output node feeds back into the logic
  // (e.g. a seal-in latch `Q = SET OR (Q AND NOT RESET)`). It cannot flow left-to-right, so it
  // is routed by the obstacle-aware A* router from the output's signal line back to the
  // consuming gate's input port — finding a local loop around the gates rather than a fixed
  // full-width lane (which looks bad when the consumer is far from the output).
  for (const [groupKey, dests] of fanOutGroups) {
    const fromId = groupKey.slice(0, groupKey.lastIndexOf('::'));
    const outNode = nodeMap.get(fromId);
    if (!outNode || outNode.gateType !== 'OUTPUT') continue; // feedback only
    // Share the output's driving signal: tap at the gate that drives the output (its output
    // port), so the feedback fans out from the same point as the output label rather than
    // retracing the driver→output wire. Same fromId => they share the trunk / a junction dot.
    const driverId = nodes.get(fromId)?.inputIds[0];
    const driver = driverId ? nodeMap.get(driverId) : undefined;
    const tapPort = driver?.outputs[0] ?? outNode.inputs[0];
    const tapFrom = driver ? driverId! : fromId;
    if (!tapPort) continue;
    void driver;
    // Keep the loop-back a clear distance (3x the wire gap) off the driver output and the
    // consumer input. The A* runs to a waypoint on the SAME side as the consumer's feedback
    // port (under a bottom port, over a top port) so the loop approaches the port from the
    // correct side without crossing the consumer's other input wire. Zero-size endpoint boxes
    // keep the driver and consumer as regular obstacles (full clearance, never hugged).
    const clearance = Math.round((3 * MIN_WIRE_SPACING) / GRID) * GRID;
    for (const dest of dests) {
      const port = dest.toPort;
      const g = dest.toLayoutNode;
      const startX = tapPort.absX + clearance;
      const endX = port.absX - clearance;
      const bottomPort = port.absY > g.absY + g.height / 2;
      const laneY = bottomPort ? g.absY + g.height + clearance : g.absY - clearance;
      const mid = routeWireAStar(
        startX, tapPort.absY, endX, laneY,
        allObstacles,
        startX, tapPort.absY, 0, 0,
        endX, laneY, 0, 0,
        false,
        routedSegments,
        canvasW, canvasH,
        tapFrom,
      );
      const pts = [
        { x: tapPort.absX, y: tapPort.absY }, ...mid,
        { x: endX, y: port.absY }, { x: port.absX, y: port.absY },
      ];
      const clean: { x: number; y: number }[] = [];
      for (const p of pts) {
        const last = clean[clean.length - 1];
        if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
        if (clean.length >= 2) {
          const a = clean[clean.length - 2], b = clean[clean.length - 1];
          const colinH = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - p.y) < 0.5;
          const colinV = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - p.x) < 0.5;
          if (colinH || colinV) clean.pop();
        }
        clean.push(p);
      }
      wires.push({ id: uid('wire'), points: clean, fromId: tapFrom, toId: dest.toId, feedback: true });
      routedSegments.push({ points: clean, fromId: tapFrom });
      addJunction(tapPort.absX, tapPort.absY);
    }
  }

  // Shared fan-out trunk: when one source feeds several destinations and two of its wires
  // turn vertically at nearly the same X, snap them to a single shared channel. Same-source
  // overlap is intentional (it reads as one trunk) and it collapses the near-duplicate
  // junction dots into one clean T-tap. Snapping toward the gate-most X only shortens the
  // peel-off horizontals, so it cannot introduce a backtrack.
  {
    const bySource = new Map<string, { w: LayoutWire; x: number }[]>();
    for (const w of wires) {
      if (w.points.length !== 4) continue;
      if (Math.abs(w.points[1].x - w.points[2].x) >= 1) continue;       // middle segment vertical
      if (Math.abs(w.points[0].y - w.points[1].y) >= 1) continue;       // exits horizontally
      const arr = bySource.get(w.fromId) ?? [];
      arr.push({ w, x: w.points[1].x });
      bySource.set(w.fromId, arr);
    }
    // The relocated branch (vertical at sharedX + its peel-off horizontal) must satisfy the shared
    // separation contract. Same-source wires are skipped — the whole point is that they merge into
    // one trunk. Crossovers with other nets are fine; only sub-MIN parallel crowding is rejected.
    // segCrowds/wireClear DELIBERATELY ignore exact-collinear overlap (deferring to the "overlap
    // check elsewhere" — the no-parallel-overlap invariant), so this pass must ALSO reject a move
    // that lands a segment exactly on a CROSS-NET parallel run (overlap >= GRID) — otherwise snapping
    // a branch to the gate-most X can drop it right on top of another net's channel. Its sibling
    // passes (fan-in nesting, the entrance pass) carry this same collinear guard; without it the
    // trunk merge can silently undo the track pass's overlap-avoiding placement.
    const collinearHitsOtherNet = (pts: { x: number; y: number }[], selfFrom: string) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const horiz = Math.abs(a.y - b.y) < 0.5;
        if (!horiz && Math.abs(a.x - b.x) >= 0.5) continue;   // only axis-aligned segments
        const perp = horiz ? a.y : a.x;
        const s0 = horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
        const s1 = horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
        for (const w of wires) {
          if (w.fromId === selfFrom) continue;               // same source shares the trunk (intentional)
          for (let j = 0; j < w.points.length - 1; j++) {
            const c = w.points[j], d = w.points[j + 1];
            const oHoriz = Math.abs(c.y - d.y) < 0.5;
            if (oHoriz !== horiz || (!oHoriz && Math.abs(c.x - d.x) >= 0.5) || (oHoriz && Math.abs(c.x - d.x) < 0.5)) continue;
            if (Math.abs((oHoriz ? c.y : c.x) - perp) >= 0.5) continue;   // not collinear
            const o0 = oHoriz ? Math.min(c.x, d.x) : Math.min(c.y, d.y);
            const o1 = oHoriz ? Math.max(c.x, d.x) : Math.max(c.y, d.y);
            if (Math.min(s1, o1) - Math.max(s0, o0) >= GRID) return true; // collinear overlap
          }
        }
      }
      return false;
    };
    const moveClear = (self: LayoutWire, sharedX: number) => {
      const moved = [self.points[0], { x: sharedX, y: self.points[1].y }, { x: sharedX, y: self.points[2].y }, self.points[3]];
      return wireClear(moved, o => o.fromId === self.fromId) && !collinearHitsOtherNet(moved, self.fromId);
    };
    for (const group of bySource.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.x - b.x);
      let start = 0;
      for (let i = 1; i <= group.length; i++) {
        if (i === group.length || group[i].x - group[i - 1].x > FANIN_SPACING) {
          if (i - start >= 2) {
            const sharedX = group[i - 1].x; // gate-most X in the cluster
            if (group.slice(start, i).every(g => moveClear(g.w, sharedX))) {
              for (let k = start; k < i; k++) {
                group[k].w.points[1].x = sharedX;
                group[k].w.points[2].x = sharedX;
              }
            }
          }
          start = i;
        }
      }
    }
  }

  // ── Gate-entrance contract (single guarantee) ────────────────────────────────────────────────
  // Every wire entering a gate input port MUST arrive with a horizontal approach of at least
  // GATE_ENTRANCE, so its final turn sits clear of the gate body/curve and the wire visibly enters
  // horizontally instead of turning on the gate's edge. The reshaping passes above (channel tracks,
  // fan-in nesting) satisfy this only as a SIDE EFFECT and each has an escape hatch that can leave a
  // gate-hugging entrance behind — the track pass skips multi-bend wires by design, and nesting is
  // all-or-nothing (it reverts a whole group to raw A* geometry when one channel won't fit). So a
  // multi-bend A* route whose final vertical lands a few px off the gate was fixed by NEITHER pass.
  // This is the ONE place that GUARANTEES the contract for EVERY gate-input wire regardless of how it
  // was routed, backed by an invariant (invariants.spec: "gate-input wires keep the GATE_ENTRANCE
  // approach"). It only pulls a turn back (never toward the gate) and validates every move through
  // the shared separation contract (wireClear), gate clearance, and a no-new-crossing check, so it
  // can never introduce a crowd, a hug, or a crossing; a move that can't be made cleanly is left as
  // routed (genuine congestion, which the invariant then surfaces rather than hiding).
  {
    // Crossings contributed by one wire against all other cross-net, non-feedback wires (mirrors
    // findWireCrossings' H×V test, interior-only). Used to reject any reshape that adds a crossing.
    type XY = { x: number; y: number };
    const hvHit = (h1: XY, h2: XY, v1: XY, v2: XY) =>
      Math.abs(h1.y - h2.y) < 1 && Math.abs(v1.x - v2.x) < 1 &&
      h1.y > Math.min(v1.y, v2.y) - 1 && h1.y < Math.max(v1.y, v2.y) + 1 &&
      v1.x > Math.min(h1.x, h2.x) - 1 && v1.x < Math.max(h1.x, h2.x) + 1;
    const wireCrosses = (self: LayoutWire): number => {
      let c = 0;
      for (const o of wires) {
        if (o === self || o.fromId === self.fromId || o.feedback) continue;
        for (let i = 0; i < self.points.length - 1; i++)
          for (let j = 0; j < o.points.length - 1; j++) {
            const p1 = self.points[i], p2 = self.points[i + 1], q1 = o.points[j], q2 = o.points[j + 1];
            if (hvHit(p1, p2, q1, q2) || hvHit(q1, q2, p1, p2)) c++;
          }
      }
      return c;
    };
    // Collinear-overlap check: segCrowds (the spacing contract) deliberately ignores segments at the
    // SAME perpendicular coordinate ("overlap check elsewhere" — the no-parallel-overlap invariant).
    // The entrance pass must honour that half too, or a straightened/pulled-back segment could land
    // exactly on another net's parallel run. Rejects a proposed geometry whose axis-aligned segment
    // overlaps a cross-net parallel segment at the same coordinate by >= GRID.
    const overlapsCollinear = (pts: XY[], skip: (w: LayoutWire) => boolean): boolean => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const horiz = Math.abs(a.y - b.y) < 0.5;
        if (!horiz && Math.abs(a.x - b.x) >= 0.5) continue;
        const perp = horiz ? a.y : a.x, mn = horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y), mx = horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
        for (const o of wires) {
          if (skip(o)) continue;
          for (let k = 0; k < o.points.length - 1; k++) {
            const c = o.points[k], d = o.points[k + 1];
            const oh = Math.abs(c.y - d.y) < 0.5;
            if (oh !== horiz || (!oh && Math.abs(c.x - d.x) >= 0.5) || (oh && Math.abs(c.x - d.x) < 0.5)) continue;
            if (Math.abs((oh ? c.y : c.x) - perp) >= 0.5) continue;    // only exact-collinear runs
            const omn = oh ? Math.min(c.x, d.x) : Math.min(c.y, d.y), omx = oh ? Math.max(c.x, d.x) : Math.max(c.y, d.y);
            if (Math.min(mx, omx) - Math.max(mn, omn) >= GRID) return true;
          }
        }
      }
      return false;
    };
    for (const w of wires) {
      if (w.feedback) continue;
      const p = w.points, n = p.length;
      if (n < 3) continue;
      const dest = nodeMap.get(w.toId);
      if (!dest || dest.gateType === 'INPUT' || dest.gateType === 'OUTPUT') continue; // gate inputs only
      const port = p[n - 1];
      if (Math.abs(p[n - 2].y - port.y) >= 0.5) continue;                // enters horizontally (invariant)
      if (Math.abs(port.x - p[n - 2].x) >= GATE_ENTRANCE - 0.5) continue; // already clear
      const before = wireCrosses(w);
      const skip = (o: LayoutWire) => o.id === w.id || o.fromId === w.fromId;

      // (1) Straight-first: collinear source & port whose A* route wandered — one straight segment
      // removes the wander AND the hug at once, if the straight path is clean.
      if (Math.abs(p[0].y - port.y) < 0.5 && port.x - p[0].x >= GATE_ENTRANCE - 0.5) {
        const straight = [{ x: p[0].x, y: port.y }, { x: port.x, y: port.y }];
        if (hGateClear(port.y, p[0].x, port.x, w.fromId) && hGateClear(port.y, p[0].x, port.x, w.toId) &&
            wireClear(straight, skip) && !overlapsCollinear(straight, skip)) {
          const saved = w.points; w.points = straight;
          if (wireCrosses(w) <= before) continue;                        // accept
          w.points = saved;                                              // else revert, try (2)
        }
      }

      // (2) Pull the tail vertical back to the gate-most clear track <= port.x - GATE_ENTRANCE. Needs
      // a movable tail vertical (>= 4 points, so it isn't the segment anchored at the source).
      if (n < 4) continue;
      const tv = n - 3;                                                  // tail vertical p[tv]->p[tv+1]
      if (Math.abs(p[tv].x - p[tv + 1].x) >= 0.5) continue;             // must be vertical
      if (Math.abs(p[tv - 1].y - p[tv].y) >= 0.5) continue;            // preceded by a horizontal run
      const preStartX = p[tv - 1].x, preY = p[tv].y, portY = port.y;
      const saved = p.map(pt => ({ x: pt.x, y: pt.y }));
      let placed = false;
      const hi = Math.floor((port.x - GATE_ENTRANCE) / GRID) * GRID;
      for (let x = hi; x > preStartX + 0.5; x -= GRID) {                 // leftward, keep pre-horizontal non-degenerate
        p[tv].x = x; p[tv + 1].x = x;
        const seg = [{ x: preStartX, y: preY }, { x, y: preY }, { x, y: portY }, { x: port.x, y: portY }];
        if (hGateClear(preY, preStartX, x, w.fromId) && vGateClear(x, preY, portY) &&
            hGateClear(portY, x, port.x, w.toId) && wireClear(seg, skip) &&
            !overlapsCollinear(seg, skip) && wireCrosses(w) <= before) {
          placed = true; break;
        }
      }
      if (!placed) for (let i = 0; i < n; i++) { p[i].x = saved[i].x; p[i].y = saved[i].y; } // revert
    }

    // Joint fallback: a wire can still hug a gate when a SIBLING fan-in channel occupies the only
    // clean track (e.g. three inputs converging where the gate-clear boundary, one input's channel,
    // and an unrelated trunk-end all coincide). Re-pack ALL of that gate's incoming tail verticals
    // onto distinct tracks stepping left from the gate-clear boundary, giving the gate-most track to
    // the LEAST-deflected (straightest) wire so no crossing is introduced. All-or-nothing and fully
    // validated (entrance + separation + gate clearance + no net new crossings): committed only if
    // every incoming wire then clears, else the whole gate reverts — so it can only resolve a hug.
    const countCross = (): number => {
      let c = 0;
      for (let i = 0; i < wires.length; i++)
        for (let j = i + 1; j < wires.length; j++) {
          const a = wires[i], b = wires[j];
          if (a.fromId === b.fromId || a.feedback || b.feedback) continue;
          for (let si = 0; si < a.points.length - 1; si++)
            for (let sj = 0; sj < b.points.length - 1; sj++)
              if (hvHit(a.points[si], a.points[si + 1], b.points[sj], b.points[sj + 1]) ||
                  hvHit(b.points[sj], b.points[sj + 1], a.points[si], a.points[si + 1])) c++;
        }
      return c;
    };
    const violates = (w: LayoutWire) => {
      const p = w.points, port = p[p.length - 1];
      return p.length >= 4 && Math.abs(p[p.length - 2].y - port.y) < 0.5 &&
        Math.abs(port.x - p[p.length - 2].x) < GATE_ENTRANCE - 0.5;
    };
    for (const gate of layoutNodes) {
      if (gate.gateType === 'INPUT' || gate.gateType === 'OUTPUT') continue;
      const incoming = wires.filter(w => !w.feedback && w.toId === gate.id && w.points.length >= 4);
      if (incoming.length < 2 || !incoming.some(violates)) continue;
      // Each incoming wire must expose a movable tail vertical (clean H–V–H tail).
      const items: { w: LayoutWire; tv: number; preStartX: number; preY: number; portY: number; portX: number; deflect: number }[] = [];
      let shapesOk = true;
      for (const w of incoming) {
        const p = w.points, m = p.length, port = p[m - 1], tv = m - 3;
        if (Math.abs(p[m - 2].y - port.y) >= 0.5 || Math.abs(p[tv].x - p[tv + 1].x) >= 0.5 || Math.abs(p[tv - 1].y - p[tv].y) >= 0.5) { shapesOk = false; break; }
        items.push({ w, tv, preStartX: p[tv - 1].x, preY: p[tv].y, portY: port.y, portX: port.x, deflect: Math.abs(p[0].y - port.y) });
      }
      if (!shapesOk) continue;
      items.sort((a, b) => a.deflect - b.deflect);                     // straightest first → gate-most track
      const boundary = Math.floor((gate.absX - GATE_CLEARANCE) / GRID) * GRID;
      const crossBefore = countCross();
      const saved = items.map(it => it.w.points.map(pt => ({ x: pt.x, y: pt.y })));
      const used: number[] = [];
      let good = true;
      for (const it of items) {
        const skip = (o: LayoutWire) => o.id === it.w.id || o.fromId === it.w.fromId;
        let placedX: number | null = null;
        const top = Math.min(boundary, Math.floor((it.portX - GATE_ENTRANCE) / GRID) * GRID);
        for (let x = top; x > it.preStartX + 0.5; x -= GRID) {
          if (used.some(u => Math.abs(u - x) < MIN_WIRE_SPACING - 0.5)) continue;
          it.w.points[it.tv].x = x; it.w.points[it.tv + 1].x = x;
          const seg = [{ x: it.preStartX, y: it.preY }, { x, y: it.preY }, { x, y: it.portY }, { x: it.portX, y: it.portY }];
          if (hGateClear(it.preY, it.preStartX, x, it.w.fromId) && vGateClear(x, it.preY, it.portY) &&
              hGateClear(it.portY, x, it.portX, it.w.toId) && wireClear(seg, skip) && !overlapsCollinear(seg, skip)) { placedX = x; break; }
        }
        if (placedX === null) { good = false; break; }
        used.push(placedX);
      }
      if (good && countCross() > crossBefore) good = false;            // never add a crossing
      if (!good) items.forEach((it, i) => { it.w.points = saved[i]; }); // revert the whole gate
    }
  }

  // Snap an output to its incoming wire's approach Y. A wire that had to clear a gate body
  // (vertical clearance) can arrive a few px off its output port, leaving a small terminal
  // jog. Since an output is a sink, just move it to where the wire arrives — eliminating the
  // jog — provided it stays clear of its sibling outputs in the same column.
  for (const o of layoutNodes) {
    if (o.gateType !== 'OUTPUT' || !o.inputs[0]) continue;
    const w = wires.find(x => x.toId === o.id && !x.feedback);
    if (!w || w.points.length < 3) continue;
    const p = w.points;
    // Find a small vertical jog (< MIN_DOGLEG) in the last two segments — whether the wire
    // enters with the jog as its final segment, or jogs then runs a short horizontal into the
    // port. The "run" Y on the far side is where the wire actually travels; move the output
    // there (and collapse the jog), as long as it stays clear of its sibling outputs.
    let k = -1;
    for (let s = p.length - 2; s >= Math.max(0, p.length - 3); s--) {
      const a = p[s], b = p[s + 1];
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) >= 0.5 && Math.abs(a.y - b.y) < MIN_DOGLEG) { k = s; break; }
    }
    if (k < 0) continue;
    const newY = Math.round(p[k].y / GRID) * GRID; // the run Y (far side of the jog)
    const clash = layoutNodes.some(s => s !== o && s.gateType === 'OUTPUT' && s.absX === o.absX &&
      Math.abs((s.absY + s.height / 2) - newY) < MIN_PORT_GAP - 0.5);
    if (clash) continue;
    o.inputs[0].absY = newY;
    o.absY = Math.round((newY - o.height / 2) / GRID) * GRID;
    for (let m = k + 1; m < p.length; m++) p[m].y = newY; // collapse the jog onto the run
    w.points = p.filter((pt, idx) => idx === 0 ||
      Math.abs(pt.x - p[idx - 1].x) >= 0.5 || Math.abs(pt.y - p[idx - 1].y) >= 0.5);
  }

  // Final straightening for a block output port that feeds a single output node directly (no
  // gate between them, e.g. a generic FB): co-locate the port and the node and draw one straight
  // segment, so multi-output blocks never leave a residual jog after the earlier snap passes.
  for (const w of wires) {
    if (w.feedback || w.points.length < 2) continue;
    const src = nodeMap.get(w.fromId);
    const dst = nodeMap.get(w.toId);
    if (!src || src.blockType !== 'FB' || !dst || dst.gateType !== 'OUTPUT' || !dst.inputs[0]) continue;
    const fn = nodes.get(dst.id);
    const sp = src.outputs.find(op => op.name === (fn?.inputPorts?.[0] ?? 'OUT'));
    if (!sp || Math.abs(sp.absX - w.points[0].x) > 0.5 || sp.absX >= dst.inputs[0].absX) continue;
    // Only safe to move the port if this is its sole wire (not shared with another consumer).
    if (wires.filter(o => o.fromId === w.fromId && Math.abs(o.points[0].y - sp.absY) < 0.5).length > 1) continue;
    const y = dst.inputs[0].absY;
    sp.absY = y;
    w.points = [{ x: sp.absX, y }, { x: dst.inputs[0].absX, y }];
  }

  // Junction dots mark where a NET actually branches — a point where its wires' segments leave in
  // three or more distinct directions (a T or a cross). A point where two same-source wires merely
  // bend together (only two directions, e.g. a shared trunk turning a corner) is NOT a branch and
  // gets no dot; a point where the trunk continues straight and one branch peels off (a T-tap) does.
  {
    const bySource = new Map<string, LayoutWire[]>();
    for (const w of wires) { const a = bySource.get(w.fromId); if (a) a.push(w); else bySource.set(w.fromId, [w]); }
    const dirFrom = (ax: number, ay: number, bx: number, by: number): string =>
      Math.abs(ax - bx) >= 0.5 ? (bx > ax ? 'R' : 'L') : (by > ay ? 'D' : 'U');
    for (const group of bySource.values()) {
      if (group.length < 2) continue;                            // a single wire never taps itself
      const pts = new Map<string, { x: number; y: number }>();   // candidate points: every vertex in the net
      for (const w of group) for (const p of w.points) pts.set(`${Math.round(p.x)},${Math.round(p.y)}`, p);
      for (const { x: px, y: py } of pts.values()) {
        const set = new Set<string>();
        for (const w of group) {
          const pp = w.points;
          for (let s = 0; s < pp.length - 1; s++) {
            const a = pp[s], b = pp[s + 1];
            const atA = Math.abs(a.x - px) < 1 && Math.abs(a.y - py) < 1;
            const atB = Math.abs(b.x - px) < 1 && Math.abs(b.y - py) < 1;
            if (atA) set.add(dirFrom(a.x, a.y, b.x, b.y));       // segment leaves pk toward b
            else if (atB) set.add(dirFrom(b.x, b.y, a.x, a.y));  // toward a
            else {                                               // pk strictly interior → the run passes through both ways
              const horiz = Math.abs(a.y - b.y) < 0.5;
              const through = horiz
                ? Math.abs(py - a.y) < 1 && px > Math.min(a.x, b.x) + 0.5 && px < Math.max(a.x, b.x) - 0.5
                : Math.abs(px - a.x) < 1 && py > Math.min(a.y, b.y) + 0.5 && py < Math.max(a.y, b.y) - 0.5;
              if (through) { set.add(dirFrom(px, py, a.x, a.y)); set.add(dirFrom(px, py, b.x, b.y)); }
            }
          }
        }
        if (set.size >= 3) addJunction(px, py);
      }
    }
  }

  // Node and port positions were already grid-snapped before routing. Snap only the
  // interior wire vertices to the grid here, leaving each wire's first/last point exact
  // so endpoints stay glued to their ports (notably OR inputs that tap the curve off-grid).
  for (const w of wires) {
    for (let i = 1; i < w.points.length - 1; i++) {
      w.points[i].x = Math.round(w.points[i].x / GRID) * GRID;
      w.points[i].y = Math.round(w.points[i].y / GRID) * GRID;
    }
  }
  for (const j of junctions) {
    j.x = Math.round(j.x / GRID) * GRID;
    j.y = Math.round(j.y / GRID) * GRID;
  }

  // Merge near-duplicate junction dots (e.g. two fan-out branches that peel off within a
  // few px of each other) so a split reads as one clean dot rather than a smudge.
  const MERGE_DIST = 8;
  const mergedJunctions: LayoutJunction[] = [];
  for (const j of junctions) {
    if (!mergedJunctions.some(m => Math.abs(m.x - j.x) <= MERGE_DIST && Math.abs(m.y - j.y) <= MERGE_DIST)) {
      mergedJunctions.push(j);
    }
  }

  placeNetLabels(labels, wires, layoutNodes, mergedJunctions, opts);

  // Re-normalise vertical position: the alignment/collision passes can drift content downward
  // from the assigned coordinates, leaving empty space at the top. Shift everything uniformly
  // (preserving every relative position and wire shape) so the topmost content sits at PAD_Y.
  {
    let minY = Infinity;
    for (const n of layoutNodes) minY = Math.min(minY, n.absY);
    for (const w of wires) for (const p of w.points) minY = Math.min(minY, p.y);
    for (const l of labels) minY = Math.min(minY, l.y);        // a label may sit above the topmost node
    const dy = PAD_Y - minY;
    if (Number.isFinite(dy) && Math.abs(dy) >= GRID) {
      for (const n of layoutNodes) {
        n.absY += dy;
        for (const p of n.inputs) p.absY += dy;
        for (const p of n.outputs) p.absY += dy;
      }
      for (const w of wires) for (const p of w.points) p.y += dy;
      for (const j of mergedJunctions) j.y += dy;
      for (const l of labels) { l.y += dy; l.anchorY += dy; }  // labels are anchored to gates — shift with them (leaderX/Y assigned later on final geometry)
    }
  }

  // Collapse blank vertical bands between disconnected logic sections. A fully-empty horizontal band
  // (no node body, label, or wire — including verticals passing through) means the content above and
  // below it are not connected by any wire, so pulling the lower section up cannot distort a wire or
  // cause an overlap. Each such band wider than SECTION_GAP is reduced to SECTION_GAP, removing the
  // wasted space while keeping sections visually separated. Uniform per-section shift, so relative
  // geometry (and therefore every crossing/dogleg) is preserved.
  {
    const SECTION_GAP = 50;
    const occ = new Set<number>();
    const mark = (y0: number, y1: number) => { for (let y = Math.floor(Math.min(y0, y1) / GRID) * GRID; y <= Math.max(y0, y1) + 0.5; y += GRID) occ.add(y); };
    for (const n of layoutNodes) mark(n.absY, n.absY + n.height);
    for (const l of labels) mark(l.y, l.y + l.height);
    for (const w of wires) for (let i = 0; i < w.points.length - 1; i++) mark(w.points[i].y, w.points[i + 1].y);
    const ys = [...occ].sort((a, b) => a - b);
    const shifts: { fromY: number; amount: number }[] = [];
    for (let k = 1; k < ys.length; k++) {
      const emptySpan = ys[k] - ys[k - 1] - GRID;                 // clear cells strictly between two occupied rows
      if (emptySpan > SECTION_GAP) shifts.push({ fromY: ys[k] - 0.5, amount: emptySpan - SECTION_GAP });
    }
    if (shifts.length) {
      const shiftFor = (y: number) => shifts.reduce((s, sh) => s + (y >= sh.fromY ? sh.amount : 0), 0);
      for (const n of layoutNodes) {
        const dy = shiftFor(n.absY);
        if (!dy) continue;
        n.absY -= dy;
        for (const p of n.inputs) p.absY -= dy;
        for (const p of n.outputs) p.absY -= dy;
      }
      for (const w of wires) for (const p of w.points) p.y -= shiftFor(p.y);
      for (const j of mergedJunctions) j.y -= shiftFor(j.y);
      for (const l of labels) { const dy = shiftFor(l.y); l.y -= dy; l.anchorY -= dy; }
    }
  }

  const maxX = Math.max(...layoutNodes.map(n => n.absX + n.width), ...wires.flatMap(w => w.points.map(p => p.x)), ...labels.map(l => l.x + l.width));
  const maxY = Math.max(...layoutNodes.map(n => n.absY + n.height), ...wires.flatMap(w => w.points.map(p => p.y)), ...labels.map(l => l.y + l.height));

  return {
    nodes: layoutNodes,
    wires,
    junctions: mergedJunctions,
    labels,
    width: maxX,
    height: maxY,
    options: opts,
  };
}



export { MIN_PORT_GAP, MIN_DOGLEG };
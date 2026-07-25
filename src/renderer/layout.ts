// layout.ts is the thin orchestrator: layoutDiagram runs candidate layouts (via layoutOnce) and picks
// the best on measured geometry; layoutOnce is placeNodes -> routeWires -> bounds. Everything else
// lives in ./layout/*: types, geometry, placement, routing, labels, scoring (crossings), crossmin.
import type { Diagram, RenderOptions } from '../parser/ast.js';
import { DEFAULT_OPTIONS } from '../parser/ast.js';

import type {
  LayoutPort, LayoutNode, LayoutWire, LayoutJunction, LayoutLabel, LayoutResult, WireCrossing,
} from './layout/types.js';
export type { LayoutPort, LayoutNode, LayoutWire, LayoutJunction, LayoutLabel, LayoutResult, WireCrossing };
import { GRID, MIN_DOGLEG, MIN_PORT_GAP } from './layout/types.js';
import { findWireCrossings } from './layout/crossings.js';
export { findWireCrossings };
import { symmetriseSmallGates } from './layout/symmetry.js';
import { placeNetLabels, assignLeaderTargets } from './layout/labels.js';
import { placeNodes } from './layout/placement.js';
import { routeWires } from './layout/routing.js';
import { resetId } from './layout/geometry.js';

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
export function layoutDiagram(diagram: Diagram, options?: RenderOptions): LayoutResult {
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
  // True when two outputs in one column share a source row — the only case where the OUTPUT_ORDER=AUTO
  // tie-break direction changes anything (#36). Source Y is the driving wire's start point.
  const hasTiedOutputs = (l: LayoutResult): boolean => {
    const byCol = new Map<number, Set<number>>();
    for (const n of l.nodes) {
      if (n.gateType !== 'OUTPUT') continue;
      const w = l.wires.find(wr => wr.toId === n.id && !wr.feedback && wr.points.length > 0);
      if (!w) continue;
      const sy = Math.round(w.points[0].y);
      const seen = byCol.get(n.absX) ?? new Set<number>();
      if (seen.has(sy)) return true;
      seen.add(sy); byCol.set(n.absX, seen);
    }
    return false;
  };
  const score = (l: LayoutResult): number[] => [overlaps(l), bodyIntrusions(l), subMinDoglegs(l), cr(l), bends(l), l.height];
  const better = (l: LayoutResult, b: LayoutResult) => {
    const sl = score(l), sb = score(b);
    for (let i = 0; i < sl.length; i++) if (sl[i] !== sb[i]) return sl[i] < sb[i];
    return false;                                                 // tie → keep the earlier candidate
  };

  // Select + FINALISE the best candidate for a given connector setting. Finalisation (symmetry,
  // net-label placement, leader targets) runs the post-passes that move wires AFTER candidate scoring,
  // so we finalise before any cross-setting comparison — otherwise a post-pass could turn a winner into
  // a loser unseen.
  const pick = (connectors: boolean, outputTieDeep: boolean): LayoutResult => {
    let b = layoutOnce(diagram, options, 'heuristic', false, connectors, outputTieDeep);
    const take = (l: LayoutResult) => { if (better(l, b)) b = l; };
    take(layoutOnce(diagram, options, 'heuristic', true, connectors, outputTieDeep));   // lane-tight (collapses voids)
    // Reach for the crossmin candidates when the current best is not already clean. The connector axis
    // stays heuristic-only: connectorisation's benefit is largely orthogonal to crossmin ordering, and
    // its per-net O(E²) validation makes extra connector candidates expensive (see #23).
    if (!connectors && (cr(b) > 0 || overlaps(b) > 0 || bodyIntrusions(b) > 0)) {
      take(layoutOnce(diagram, options, 'crossmin', false, connectors, outputTieDeep));
      take(layoutOnce(diagram, options, 'crossmin', true, connectors, outputTieDeep));
    }
    symmetriseSmallGates(b);                                    // cosmetic, validated post-pass
    placeNetLabels(b.labels, b.wires, b.nodes, b.junctions, options ?? DEFAULT_OPTIONS); // FINAL geometry
    assignLeaderTargets(b);                                     // net-label leader targets on FINAL geometry
    return b;
  };

  // Crossing-aware OUTPUT_ORDER = AUTO (#36): the tie-break for two outputs sharing a source row has no
  // universally-best direction, so try BOTH and keep whichever renders better on the full score —
  // instead of a static heuristic that helps one diagram and regresses another. Only run the second
  // layout when the diagram actually HAS tied outputs (else the tie-break is inert), so it costs
  // nothing on the common case.
  // Try the alternative tie-break only for smaller diagrams: it is a *second full layout*, and on large
  // diagrams the tie-break never changed the outcome in testing (their crossings come from fan-out, not
  // output stacking) — so gating on size keeps the second layout off the expensive path (see #23) while
  // still fixing the small cases it helps (Boolean Algebra). A cheaper output-only re-place is a follow-up.
  const auto = (options ?? DEFAULT_OPTIONS).outputOrder === 'AUTO';
  const TIE_MAX_NODES = 28;
  const pickBest = (connectors: boolean): LayoutResult => {
    let b = pick(connectors, false);
    if (auto && b.nodes.length <= TIE_MAX_NODES && hasTiedOutputs(b)) {
      const alt = pick(connectors, true);
      if (better(alt, b)) b = alt;
    }
    return b;
  };

  let best = pickBest(false);
  // Off-page connector fan-out (#37): when OPTION FANOUT_CONNECTORS is on, connectorising very-high-
  // fan-out nets is offered as an alternative and kept only if the FINALISED result wins on the full
  // score (overlaps ▸ intrusions ▸ sub-min doglegs ▸ crossings ▸ bends ▸ height). So it de-tangles the
  // diagrams it helps (Building 60→35, Reactor 50→25) and never regresses one it doesn't (Railway).
  if ((options ?? DEFAULT_OPTIONS).fanoutConnectors) {
    const withConnectors = pickBest(true);
    if (better(withConnectors, best)) best = withConnectors;
  }
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


function layoutOnce(diagram: Diagram, options: RenderOptions | undefined, strategy: 'heuristic' | 'crossmin', laneTight = false, connectors = false, outputTieDeep = false): LayoutResult {
  resetId();

  // `connectors` is a per-candidate axis (like laneTight), NOT the global option: layoutDiagram tries
  // both off and on and keeps the best on the full score, so off-page connectors can never regress a
  // diagram. Override the flag routeWires reads with this candidate's value.
  const opts = connectors === (options ?? DEFAULT_OPTIONS).fanoutConnectors
    ? (options ?? DEFAULT_OPTIONS)
    : { ...(options ?? DEFAULT_OPTIONS), fanoutConnectors: connectors };

  // Two phases: place every node (graph → sized gates → coordinates), then route + reshape the wires.
  const { nodes, intermediateLabels, layoutNodes, nodeMap } = placeNodes(diagram, opts, strategy, laneTight, outputTieDeep);
  const { wires, junctions: mergedJunctions, labels } = routeWires(nodes, layoutNodes, nodeMap, intermediateLabels, opts);

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
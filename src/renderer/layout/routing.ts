// Wire routing + all wire-reshaping passes: fan-out A* routing, the separation-contract helpers
// (segCrowds/wireClear/vGateClear/hGateClear), channel-track assignment, fan-in nesting,
// obstacle-aware output placement, shared fan-out trunk merge, the gate-entrance contract, junction
// dots, and the final vertical re-normalise / section-collapse. Takes the PLACED nodes and returns
// the wires + merged junctions + net labels (mutating layoutNodes' Y in the normalise passes).
import type { FlatNode, IntermediateLabel } from '../graph.js';
import type { RenderOptions } from '../../parser/ast.js';
import { routeWireAStar, type GateObstacle, type RoutedSegment } from '../astar-router.js';
import { uid } from './geometry.js';
import { placeNetLabels } from './labels.js';
import { findWireCrossings } from './crossings.js';
import { estimateTextWidth } from '../math-renderer.js';
import type { LayoutNode, LayoutPort, LayoutWire, LayoutJunction, LayoutLabel } from './types.js';
import { GRID, MIN_DOGLEG, MIN_PORT_GAP, MIN_WIRE_SPACING, PAD_Y } from './types.js';

export function routeWires(
  nodes: Map<string, FlatNode>,
  layoutNodes: LayoutNode[],
  nodeMap: Map<string, LayoutNode>,
  intermediateLabels: IntermediateLabel[],
  opts: RenderOptions,
): { wires: LayoutWire[]; junctions: LayoutJunction[]; labels: LayoutLabel[] } {
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // ROUTING PIPELINE. Setup builds the wires; then a fixed ordered sequence of PASSES reshapes them,
  // each validating its moves through the shared separation contract + gate clearance below. In order:
  //   Setup   net-label obstacles · fan-out groups · A* fan-out routing · shared contract helpers
  //   Pass 1  Channel track assignment      — spread single-turn verticals onto distinct channel tracks
  //   Pass 2  Nested fan-in channels         — straight nested H–V–H into congested multi-input gates
  //   Pass 3  Obstacle-aware output placement— move a shadowed output off a detour / gate-crossing
  //   Pass 4  Single-consumer input un-wrap  — un-wrap an input that A* wrapped over a sibling block
  //   Pass 5  Straighten sub-dogleg jogs     — collapse gratuitous < MIN_DOGLEG steps when gate-clear
  //   Pass 6  Feedback loop-back routing     — A* loop-back for output→gate seal-in edges
  //   Pass 7  Shared fan-out trunk merge     — snap near-coincident same-source verticals to one trunk
  //   Pass 8  Gate-entrance contract         — GUARANTEE every gate-input wire's >= GATE_ENTRANCE approach
  //   Pass 9  Output snap to approach-Y      — move a sink output onto its wire's arrival Y (drop jog)
  //   Pass 10 Block-output straighten        — co-locate an FB port with the output it feeds directly
  //   Pass 11 Junction-dot marking           — dot every true branch (>=3 directions) of each net
  //   Pass 12 Grid-snap wire vertices        — snap interior vertices (endpoints stay glued to ports)
  //   Pass 13 Merge near-duplicate junctions — collapse dots within MERGE_DIST into one
  //   Pass 14 Net-label placement            — place consumed-intermediate labels on final geometry
  //   Pass 15 Vertical re-normalise          — shift all content so the top sits at PAD_Y
  //   Pass 16 Section collapse               — squeeze empty bands between disconnected sections
  // Adding a pass here means adding a step to THIS list; the goal is to keep the list short.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
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
  // `pool` lets a hot caller pass a pre-filtered subset of wires (those near a bounded search region) so
  // the O(wires) scan shrinks to O(local) — safe because any wire outside the region ± MIN_WIRE_SPACING
  // cannot be within spacing of a segment inside it. Defaults to all wires, so every other caller is
  // unchanged. Reads current geometry either way.
  const segCrowds = (x0: number, y0: number, x1: number, y1: number, skip: (w: LayoutWire) => boolean, pool: LayoutWire[] = wires): boolean => {
    const horiz = Math.abs(y0 - y1) < 0.5;
    if (!horiz && Math.abs(x0 - x1) >= 0.5) return false; // only axis-aligned segments participate
    const perp = horiz ? y0 : x0;
    const aMin = horiz ? Math.min(x0, x1) : Math.min(y0, y1);
    const aMax = horiz ? Math.max(x0, x1) : Math.max(y0, y1);
    for (const w of pool) {
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
  const wireClear = (pts: { x: number; y: number }[], skip: (w: LayoutWire) => boolean, pool?: LayoutWire[]): boolean => {
    for (let i = 0; i < pts.length - 1; i++)
      if (segCrowds(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, skip, pool)) return false;
    return true;
  };

  // ═══ PASS 1 · Channel track assignment ══════════════════════════════════════════════════════════
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

  // ═══ PASS 2 · Nested fan-in channels ══════════════════════════════════════════════════════════
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
  const wireCross = (self: LayoutWire, pool: LayoutWire[] = wires) => {
    if (self.feedback) return 0;
    let c = 0;
    for (const o of pool) {
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

  // ═══ PASS 3 · Obstacle-aware output placement ══════════════════════════════════════════════════════
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

  // ═══ PASS 4 · Single-consumer input un-wrap ════════════════════════════════════════════════════════
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
      // Every candidate route below lives inside x∈[sx,px], y∈[py−500,py+500] (sy = py±d, d≤500; tapX
      // ∈(sx,px]). So only wires whose bbox reaches that region ± MIN_WIRE_SPACING can crowd or cross any
      // candidate — pre-filter to that local pool ONCE (O(wires)) and feed it to the O(wires) inner
      // checks (wireClear/wireCross), which run tens of thousands of times per pass. Exact: a wire outside
      // the region can neither cross a segment inside it nor sit within spacing of one (#23).
      const rM = MIN_WIRE_SPACING, rx0 = sx - rM, rx1 = px + rM, ry0 = py - 500 - rM, ry1 = py + 500 + rM;
      const localPool = wires.filter(o => {
        let miX = Infinity, maX = -Infinity, miY = Infinity, maY = -Infinity;
        for (const p of o.points) { if (p.x < miX) miX = p.x; if (p.x > maX) maX = p.x; if (p.y < miY) miY = p.y; if (p.y > maY) maY = p.y; }
        return miX <= rx1 && maX >= rx0 && miY <= ry1 && maY >= ry0;
      });
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
                !hGateClear(py, tapX, px, w.toId) || !wireClear(route, skip, localPool)) continue;
            w.points = route;
            const c = wireCross(w, localPool);
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

  // ═══ PASS 5 · Straighten sub-dogleg jogs ══════════════════════════════════════════════════════════
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

  // ═══ PASS 6 · Feedback loop-back routing ══════════════════════════════════════════════════════════
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

  // ═══ PASS 7 · Shared fan-out trunk merge ══════════════════════════════════════════════════════════
  // Shared fan-out trunk: when one source feeds several destinations and two of its wires peel off
  // the shared horizontal trunk at nearly the same X, snap those first verticals to a single shared
  // channel. Same-source overlap is intentional (it reads as one trunk) and it collapses the near-
  // duplicate junction dots into one clean T-tap — including the common case where one sibling is a
  // clean H–V–H and another is a multi-bend A* route whose first corner is the peel (e.g. an output
  // dogleg leaving the same trunk as a gate branch). Snapping toward the gate-most X only
  // lengthens/shortens the peel-off horizontal, so it cannot introduce a backtrack.
  {
    // Any wire that exits the source horizontally and then turns onto a first vertical is a peel
    // candidate — not only clean 4-point H–V–H routes. Later bends (over-top detours, etc.) keep
    // their geometry; only the trunk-exit corner moves onto the shared X.
    const bySource = new Map<string, { w: LayoutWire; x: number }[]>();
    for (const w of wires) {
      if (w.feedback || w.points.length < 4) continue;
      if (Math.abs(w.points[0].y - w.points[1].y) >= 1) continue;       // exits horizontally
      if (Math.abs(w.points[1].x - w.points[2].x) >= 1) continue;       // first turn is vertical
      if (Math.abs(w.points[1].y - w.points[2].y) < 1) continue;        // degenerate (no peel)
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
    const withPeelX = (self: LayoutWire, sharedX: number) => {
      const moved = self.points.map(p => ({ x: p.x, y: p.y }));
      moved[1].x = sharedX;
      moved[2].x = sharedX;
      return moved;
    };
    const moveClear = (self: LayoutWire, sharedX: number) => {
      const moved = withPeelX(self, sharedX);
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

  // ═══ PASS 8 · Gate-entrance contract ══════════════════════════════════════════════════════════
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

  // ═══ PASS 9 · Output snap to approach-Y ══════════════════════════════════════════════════════════
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

  // ═══ PASS 10 · Block-output straighten ══════════════════════════════════════════════════════════
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

  // ═══ PASS 11 · Junction-dot marking ══════════════════════════════════════════════════════════
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

  // ═══ PASS 12 · Grid-snap wire vertices ══════════════════════════════════════════════════════════
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

  // ═══ PASS 13 · Merge near-duplicate junctions ══════════════════════════════════════════════════════
  // Merge near-duplicate junction dots (e.g. two fan-out branches that peel off within a
  // few px of each other) so a split reads as one clean dot rather than a smudge.
  const MERGE_DIST = 8;
  const mergedJunctions: LayoutJunction[] = [];
  for (const j of junctions) {
    if (!mergedJunctions.some(m => Math.abs(m.x - j.x) <= MERGE_DIST && Math.abs(m.y - j.y) <= MERGE_DIST)) {
      mergedJunctions.push(j);
    }
  }

  // ═══ PASS 14 · Net-label placement ══════════════════════════════════════════════════════════
  placeNetLabels(labels, wires, layoutNodes, mergedJunctions, opts);

  // ═══ PASS 15 · Vertical re-normalise ══════════════════════════════════════════════════════════
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

  // ═══ PASS 16 · Section collapse ══════════════════════════════════════════════════════════
  // Collapse blank vertical bands between weakly-connected logic sections. A horizontal band that no
  // node body, label, or wire *feature* occupies — where "feature" is a wire vertex (turn) or a
  // horizontal run, but NOT the interior of a vertical run merely passing through — means the content
  // above and below share no routing in that band. Pulling the lower section up therefore only shortens
  // the vertical wires that thread the band (issue #17: an SR-latch cluster and an analog cluster that
  // meet solely at a final gate, with the latch's Q wire dropping through the gap). Each such band wider
  // than SECTION_GAP is reduced to SECTION_GAP. Uniform per-section shift, so every wire shape (and thus
  // every crossing/dogleg) is preserved and the threaded verticals stay straight, just shorter.
  {
    const SECTION_GAP = 50;
    const occ = new Set<number>();
    const mark = (y0: number, y1: number) => { for (let y = Math.floor(Math.min(y0, y1) / GRID) * GRID; y <= Math.max(y0, y1) + 0.5; y += GRID) occ.add(y); };
    for (const n of layoutNodes) mark(n.absY, n.absY + n.height);
    for (const l of labels) mark(l.y, l.y + l.height);
    for (const w of wires) {
      for (const p of w.points) mark(p.y, p.y);                     // vertices (turns/endpoints) pin their row
      for (let i = 0; i < w.points.length - 1; i++)
        if (Math.abs(w.points[i].y - w.points[i + 1].y) < 0.5) mark(w.points[i].y, w.points[i + 1].y); // horizontal runs occupy their row
      // A vertical run's interior is deliberately NOT marked, so a band it only passes through stays
      // collapsible (the uniform shift below just shortens it).
    }
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

  // ═══ Off-page connector fan-out (#37 · OPTION FANOUT_CONNECTORS) ═══════════════════════════════════
  // A very-high-fan-out net that spans much of the page is drawn as one wire that crosses everything
  // between its taps (e.g. a global "Fire Alarm" inhibit consumed by every output). Replace such nets
  // with off-page CONNECTOR stubs: a short source stub tagged with the net name, and a short stub with
  // the same tag at each consumer. The long crossing wire (and its junction dots) is removed; the
  // reader matches source ↔ sinks by the shared name — the standard schematic idiom.
  //
  // SELECTIVE: connectorising only *removes* the net's own crossings, but the short consumer stubs can
  // themselves cross wires that pass close to the ports — net-negative when the net was already well
  // routed. So each candidate is validated: build the connectorised wire set, count real crossings, and
  // keep it only if it strictly reduces the total. Greedy, most-fanned-out first, re-checked after each
  // (same accept-only-if-better principle as the candidate scorer). The O(E²) recount runs once per
  // candidate, and candidates are few (only very-high-fan-out nets qualify).
  if (opts.fanoutConnectors) {
    const FANOUT_MIN = 4, SPAN_MIN = 250, STUB = 22;
    const bySrc = new Map<string, LayoutWire[]>();
    for (const w of wires) { if (w.feedback) continue; (bySrc.get(w.fromId) ?? bySrc.set(w.fromId, []).get(w.fromId)!).push(w); }
    const candidates = [...bySrc.entries()]
      .filter(([, ws]) => { const ys = ws.flatMap(w => w.points.map(p => p.y)); return ws.length >= FANOUT_MIN && Math.max(...ys) - Math.min(...ys) >= SPAN_MIN; })
      .sort((a, b) => b[1].length - a[1].length)
      .map(([id]) => id);
    // Build the connectorised {wires, junctions, labels} for one net, off the CURRENT state.
    const build = (id: string) => {
      const ws = wires.filter(w => !w.feedback && w.fromId === id);
      const src = ws[0].points[0];
      const node = layoutNodes.find(x => x.id === id);
      const name = node?.name || node?.label || id;
      const nameW = estimateTextWidth(name, 10);
      const onNet = new Set(ws.flatMap(w => w.points.map(p => `${Math.round(p.x)},${Math.round(p.y)}`)));
      const tw = wires.filter(w => w.feedback || w.fromId !== id);
      const tj = mergedJunctions.filter(j => !onNet.has(`${Math.round(j.x)},${Math.round(j.y)}`));
      const tl: LayoutLabel[] = [
        { x: src.x + STUB + 3, y: src.y - 5, width: nameW, height: 12, anchorX: src.x, anchorY: src.y, driverId: id, name, fixed: true, connector: 'source' },
      ];
      tw.push({ id: `conn_s_${id}`, points: [{ x: src.x, y: src.y }, { x: src.x + STUB, y: src.y }], fromId: id, toId: id });
      for (const w of ws) {
        const dst = w.points[w.points.length - 1];
        tw.push({ id: `conn_d_${w.id}`, points: [{ x: dst.x - STUB, y: dst.y }, { x: dst.x, y: dst.y }], fromId: id, toId: w.toId });
        tl.push({ x: dst.x - STUB - 3 - nameW, y: dst.y - 5, width: nameW, height: 12, anchorX: dst.x, anchorY: dst.y, driverId: id, name, fixed: true, connector: 'sink' });
      }
      return { wires: tw, junctions: tj, labels: tl };
    };
    for (const id of candidates) {
      const before = findWireCrossings(wires, mergedJunctions).length;
      const t = build(id);
      if (findWireCrossings(t.wires, t.junctions).length < before) {       // keep only if it helps
        wires.length = 0; wires.push(...t.wires);
        mergedJunctions.length = 0; mergedJunctions.push(...t.junctions);
        labels.push(...t.labels);
      }
    }
  }

  return { wires, junctions: mergedJunctions, labels };
}

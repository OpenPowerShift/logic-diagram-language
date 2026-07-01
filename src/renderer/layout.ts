import type { Diagram, PortMeta, RenderOptions } from '../parser/ast.js';
import { DEFAULT_OPTIONS, resolveOptions } from '../parser/ast.js';
import { hasMathContent } from './math-renderer.js';
import { routeWireAStar, type GateObstacle, type RoutedSegment } from './astar-router.js';
import { orCurveTapX } from './gates.js';
import { buildGraph, type FlatNode } from './graph.js';

export interface LayoutPort {
  name: string;
  absX: number;
  absY: number;
  bubbled?: boolean;
  bubbledOutput?: boolean;
  style?: 'CIRCLE' | 'SQUARE';
  label?: string; // visible port label inside the body (generic FB blocks)
}

export interface LayoutNode {
  id: string;
  gateType: string;
  label?: string;
  name?: string;
  description?: string;
  absX: number;
  absY: number;
  width: number;
  height: number;
  inputs: LayoutPort[];
  outputs: LayoutPort[];
  depth: number;
  barsMode?: boolean;
  blockType?: string;                 // SEL function block
  params?: Record<string, string>;    // block settings (PU/DO/DOMINANT/...)
}

export interface LayoutWire {
  id: string;
  points: { x: number; y: number }[];
  fromId: string;
  toId: string;
  feedback?: boolean; // loop-back wire: an output fed back into the logic (e.g. a seal-in latch)
}

export interface LayoutJunction {
  x: number;
  y: number;
}

// A name/description label for a consumed intermediate signal, drawn at its fan-out junction.
export interface LayoutLabel {
  x: number;        // top-left of the label box (also a routing obstacle)
  y: number;
  width: number;
  height: number;
  anchorX: number;  // the driver output point the label annotates
  anchorY: number;
  name?: string;
  description?: string;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  wires: LayoutWire[];
  junctions: LayoutJunction[];
  labels: LayoutLabel[];
  width: number;
  height: number;
  options: RenderOptions;
}
const GATE_W = 60;
const INPUT_BAR_OFFSET = 12;
const GATE_W_MULTI = 75;
const AND_GATE_H_BASE = 45;
const PORT_SPACING = 15;

const NOT_TRIANGLE_W = 50;

const BUBBLE_R = 5;
const NOT_GATE_TOTAL_W = NOT_TRIANGLE_W + BUBBLE_R * 2 + 5;
const NOT_GATE_H = 40;

const INPUT_LABEL_W = 90;
const OUTPUT_LABEL_W = 90;
const INPUT_STUB = 10;
const OUTPUT_STUB = 10;
const PORT_SIZE = 5;

const COL_SPACING = 260;
const ROW_SPACING = 80;
const PAD_X = 170;

const PAD_Y = 50;

const MIN_PORT_GAP = 25;
const MIN_DOGLEG = 30;
const MIN_WIRE_SPACING = 10;
const MIN_CHANNEL_SPACING = 20;
const WIRE_PAD = MIN_WIRE_SPACING / 2;
const BUBBLE_STUB = 5;
const GRID = 5;
// Round a height UP to an even number of grid cells so the vertical centre (h/2) is exactly
// on the grid. AND/OR gate output ports and the OR arc tip both sit at h/2; without this the
// drawn arc tip drifts off-grid and no longer coincides with the port / junction dot.
const EVEN_CELL = 2 * GRID;
function evenGridHeight(v: number): number { return Math.ceil(v / EVEN_CELL) * EVEN_CELL; }

let _id = 0;
function uid(prefix: string): string { return `${prefix}_${++_id}`; }

function naturalCompare(a: string, b: string): number {
  const aParts = a.match(/\d+|\D+/g) ?? [a];
  const bParts = b.match(/\d+|\D+/g) ?? [b];
  for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
    const aIsNum = /^\d+$/.test(aParts[i]);
    const bIsNum = /^\d+$/.test(bParts[i]);
    if (aIsNum && bIsNum) {
      const diff = parseInt(aParts[i]) - parseInt(bParts[i]);
      if (diff !== 0) return diff;
    } else {
      const diff = aParts[i].localeCompare(bParts[i]);
      if (diff !== 0) return diff;
    }
  }
  return aParts.length - bParts.length;
}

function rectsOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number, pad: number = 0): boolean {
  return !(ax + aw + pad < bx || bx + bw + pad < ax || ay + ah + pad < by || by + bh + pad < ay);
}

// The base (pre-expansion) height of a node, mirroring the height logic in the node-creation
// loop. Used by the coordinate assignment to space nodes within a column.
function baseNodeHeight(n: FlatNode): number {
  if (n.gateType === 'DUMMY') return 0; // a thin long-edge lane; spacing comes from VGAP
  if (n.kind === 'input' || n.kind === 'output') {
    const math = (!!n.name && hasMathContent(n.name)) || (!!n.description && hasMathContent(n.description));
    return n.description || math ? 30 : 20;
  }
  if (n.blockType === 'FB') return fbDims(n).h + (n.description ? 18 : 0);
  if (n.blockType) return blockSize(n.blockType).h + (n.name ? 18 : 0) + (n.description ? 18 : 0);
  if (n.gateType === 'NOT') return NOT_GATE_H;
  const numInputs = n.inputIds.length || 2;
  const labelSpace = (n.name ? 18 : 0) + (n.description ? 18 : 0);
  return gateBodyHeight(numInputs, gateGap(n), labelSpace);
}

// ── Gate vertical layout: single source of truth ──────────────────────────────────────────────
// A gate's body is sized and its ports laid out PURELY from its port count and a per-gate vertical
// port spacing `gap`: input port i sits at top + GATE_END_PAD + i*gap, so adjacent ports are `gap`
// apart with a fixed GATE_END_PAD above the first and below the last; the body height is the span
// plus both pads (rounded up to an even grid so the dead-centre output stays on-grid). With the
// default gap = PORT_SPACING this reproduces the historical (n+1)*PORT_SPACING layout exactly; a
// larger gap (for a gate fed by labelled inputs) widens the port spacing without other passes
// needing to know. Every pass that sizes or re-places a gate body derives geometry from these.
const GATE_END_PAD = PORT_SPACING;
function gateBodyHeight(numInputs: number, gap: number = PORT_SPACING, labelSpace = 0): number {
  return evenGridHeight(Math.max(AND_GATE_H_BASE, (numInputs - 1) * gap + 2 * GATE_END_PAD) + labelSpace);
}
function gateInputPortY(top: number, i: number, gap: number = PORT_SPACING): number {
  return top + GATE_END_PAD + i * gap;
}
// A gate's first-class vertical port spacing (`portGap`), defaulting to PORT_SPACING.
function gateGap(n: FlatNode): number { return n.portGap ?? PORT_SPACING; }

// Body dimensions for a generic FB block: square-ish, sized to its port counts and labels.
function fbDims(n: FlatNode): { w: number; h: number } {
  const ni = n.inputIds.length;
  const no = Math.max(1, n.usedPorts?.size ?? 1);
  // Outputs sit at the output-stack gap (40) so the output nodes they feed line up straight;
  // inputs need only MIN_PORT_GAP. Height fits whichever side has more ports.
  const h = Math.max(50, Math.max((no - 1) * 40, (ni - 1) * MIN_PORT_GAP) + 50);
  const textW = (s?: string) => (s ? s.length * 6.5 : 0);
  const inMax = Math.max(0, ...(n.inputLabels ?? []).map(textW));
  const outMax = Math.max(0, ...[...(n.usedPorts ?? [])].map(p => textW(p === 'OUT' ? undefined : p)));
  // Room for the left labels, the centred name and the right labels without overlap.
  const w = Math.max(70, inMax + outMax + textW(n.name) + 30);
  return { w: Math.ceil(w / GRID) * GRID, h: Math.ceil(h / GRID) * GRID };
}

// Body dimensions for each SEL function block.
function blockSize(blockType: string): { w: number; h: number } {
  switch (blockType) {
    case 'TIMER': return { w: 85, h: 50 };
    case 'SR': return { w: 60, h: 55 };
    case 'COMPARE': return { w: 65, h: 50 };
    case 'RISING': case 'FALLING': return { w: 50, h: 40 };
    default: return { w: 60, h: 45 };
  }
}

// Priority-method vertical coordinate assignment (Sugiyama/Tagawa style). Each column keeps
// its fixed order (the barycentre ordering); we then alternate downward (align to sources)
// and upward (align to consumers) sweeps. In each sweep a node is moved toward the median of
// its neighbours on that side, but it may not displace a neighbour of higher-or-equal
// priority (priority = degree on the sweep side); lower-priority neighbours are pushed to keep
// the minimum gap. Returns each node's top-left Y (grid-snapped, normalised to PAD_Y).
function assignCoordinates(
  nodes: Map<string, FlatNode>,
  depthGroups: Map<number, FlatNode[]>,
  rowMap: Map<string, number>,
  maxDepth: number,
  rowSpacing: number,
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
    return (H.get(a.id)! + H.get(b.id)!) / 2 + VGAP;
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

export function layoutDiagram(diagram: Diagram, portMeta: PortMeta[] = [], options?: RenderOptions): LayoutResult {
  _id = 0;

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

    // Re-propagate gate/output rows from the updated input ranks so the order is consistent.
    for (let depth = 1; depth <= maxDepth; depth++) {
      const group = depthGroups.get(depth) ?? [];
      for (const node of group) {
        if (node.inputIds.length === 0) { rowMap.set(node.id, 0); continue; }
        const inputRows = node.inputIds.map(id => rowMap.get(id)).filter((r): r is number => r !== undefined);
        if (inputRows.length === 0) { rowMap.set(node.id, 0); continue; }
        rowMap.set(node.id, (Math.min(...inputRows) + Math.max(...inputRows)) / 2);
      }
    }
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
  const assignedY = assignCoordinates(nodes, depthGroups, rowMap, maxDepth, rowSpacing);

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
    labels.push({ x, y, width: w, height: h, anchorX: port.absX, anchorY: port.absY, name: il.name, description: il.description });
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
  function vGateClear(x: number, y0: number, y1: number): boolean {
    const yMin = Math.min(y0, y1), yMax = Math.max(y0, y1);
    for (const o of allObstacles) {
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
      const reshaped = [{ x: srcX, y: srcY }, { x: channelX, y: srcY }, { x: channelX, y: portY }, { x: portX, y: portY }];
      return wireClear(reshaped, o => o === w || o.fromId === w.fromId || fanSet.has(o));
    };

    // All-or-nothing per group: compute every nested channel, and only apply them if all are
    // valid and mutually distinct. Otherwise leave the group untouched so we never trade one
    // problem for another.
    const place = (group: LayoutWire[], offset: number) => {
      const plan: { w: LayoutWire; cx: number; srcX: number; srcY: number; portX: number; portY: number }[] = [];
      const used = new Set<number>();
      const groupMinX = Math.max(0, ...group.map(w => Math.round((w.points[0].x + MIN_DOGLEG) / GRID) * GRID));
      const room = gate.absX - GATE_CLEARANCE - groupMinX;
      const step = group.length > 1
        ? Math.max(GRID, Math.min(FANIN_SPACING, Math.floor(room / (group.length - 1) / GRID) * GRID))
        : FANIN_SPACING;
      for (let i = 0; i < group.length; i++) {
        const w = group[i];
        const srcX = w.points[0].x, srcY = w.points[0].y;
        const e = lastPt(w), portX = e.x, portY = e.y;
        let cx = gate.absX - GATE_CLEARANCE - i * step - offset;
        const minX = Math.round((srcX + MIN_DOGLEG) / GRID) * GRID;
        if (cx < minX) cx = minX;
        cx = Math.round(cx / GRID) * GRID;
        if (used.has(cx) || !channelOk(w, cx, srcX, srcY, portX, portY)) return;
        used.add(cx);
        plan.push({ w, cx, srcX, srcY, portX, portY });
      }
      for (const { w, cx, srcX, srcY, portX, portY } of plan) {
        w.points = [{ x: srcX, y: srcY }, { x: cx, y: srcY }, { x: cx, y: portY }, { x: portX, y: portY }];
      }
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
        const nextOk = vGateClear(p[k + 2].x, yA, p[k + 3].y);
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
    const moveClear = (self: LayoutWire, sharedX: number) => {
      const moved = [self.points[0], { x: sharedX, y: self.points[1].y }, { x: sharedX, y: self.points[2].y }, self.points[3]];
      return wireClear(moved, o => o.fromId === self.fromId);
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

  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      if (wires[i].fromId !== wires[j].fromId) continue;
      for (let k = 1; k < wires[i].points.length - 1; k++) {
        const pk = wires[i].points[k];
        for (let m = 0; m < wires[j].points.length - 1; m++) {
          const s0 = wires[j].points[m];
          const s1 = wires[j].points[m + 1];
          if (Math.abs(s0.y - s1.y) < 1 && Math.abs(pk.y - s0.y) < 2) {
            const minX = Math.min(s0.x, s1.x);
            const maxX = Math.max(s0.x, s1.x);
            if (pk.x >= minX - 1 && pk.x <= maxX + 1) {
              addJunction(pk.x, pk.y);
            }
          }
          if (Math.abs(s0.x - s1.x) < 1 && Math.abs(pk.x - s0.x) < 2) {
            const minY = Math.min(s0.y, s1.y);
            const maxY = Math.max(s0.y, s1.y);
            if (pk.y >= minY - 1 && pk.y <= maxY + 1) {
              addJunction(pk.x, pk.y);
            }
          }
        }
      }
      for (let k = 1; k < wires[j].points.length - 1; k++) {
        const pk = wires[j].points[k];
        for (let m = 0; m < wires[i].points.length - 1; m++) {
          const s0 = wires[i].points[m];
          const s1 = wires[i].points[m + 1];
          if (Math.abs(s0.y - s1.y) < 1 && Math.abs(pk.y - s0.y) < 2) {
            const minX = Math.min(s0.x, s1.x);
            const maxX = Math.max(s0.x, s1.x);
            if (pk.x >= minX - 1 && pk.x <= maxX + 1) {
              addJunction(pk.x, pk.y);
            }
          }
          if (Math.abs(s0.x - s1.x) < 1 && Math.abs(pk.x - s0.x) < 2) {
            const minY = Math.min(s0.y, s1.y);
            const maxY = Math.max(s0.y, s1.y);
            if (pk.y >= minY - 1 && pk.y <= maxY + 1) {
              addJunction(pk.x, pk.y);
            }
          }
        }
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

  // Re-normalise vertical position: the alignment/collision passes can drift content downward
  // from the assigned coordinates, leaving empty space at the top. Shift everything uniformly
  // (preserving every relative position and wire shape) so the topmost content sits at PAD_Y.
  {
    let minY = Infinity;
    for (const n of layoutNodes) minY = Math.min(minY, n.absY);
    for (const w of wires) for (const p of w.points) minY = Math.min(minY, p.y);
    const dy = PAD_Y - minY;
    if (Number.isFinite(dy) && Math.abs(dy) >= GRID) {
      for (const n of layoutNodes) {
        n.absY += dy;
        for (const p of n.inputs) p.absY += dy;
        for (const p of n.outputs) p.absY += dy;
      }
      for (const w of wires) for (const p of w.points) p.y += dy;
      for (const j of mergedJunctions) j.y += dy;
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

export interface WireCrossing {
  wire1From: string;
  wire1To: string;
  wire2From: string;
  wire2To: string;
  x: number;
  y: number;
}

export function findWireCrossings(wires: LayoutWire[], junctions: LayoutJunction[]): WireCrossing[] {
  const crossings: WireCrossing[] = [];
  const junctionSet = new Set(junctions.map(j => `${Math.round(j.x)},${Math.round(j.y)}`));

  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      if (wires[i].fromId === wires[j].fromId) continue;
      if (wires[i].feedback || wires[j].feedback) continue; // loop-backs run in their own lane
      for (let si = 0; si < wires[i].points.length - 1; si++) {
        for (let sj = 0; sj < wires[j].points.length - 1; sj++) {
          const p1 = wires[i].points[si], p2 = wires[i].points[si + 1];
          const q1 = wires[j].points[sj], q2 = wires[j].points[sj + 1];
          // Test a horizontal segment against a vertical segment in EITHER orientation
          // (i-horiz×j-vert and i-vert×j-horiz), so crossings are caught regardless of
          // which wire happens to come first in the list.
          const cross = (h1: { x: number; y: number }, h2: { x: number; y: number }, v1: { x: number; y: number }, v2: { x: number; y: number }) => {
            if (Math.abs(h1.y - h2.y) >= 1 || Math.abs(v1.x - v2.x) >= 1) return null;
            const y = h1.y, x = v1.x;
            const yMin = Math.min(v1.y, v2.y), yMax = Math.max(v1.y, v2.y);
            const xMin = Math.min(h1.x, h2.x), xMax = Math.max(h1.x, h2.x);
            return (y >= yMin - 1 && y <= yMax + 1 && x >= xMin - 1 && x <= xMax + 1) ? { x, y } : null;
          };
          const hit = cross(p1, p2, q1, q2) ?? cross(q1, q2, p1, p2);
          if (hit && !junctionSet.has(`${Math.round(hit.x)},${Math.round(hit.y)}`)) {
            crossings.push({
              wire1From: wires[i].fromId, wire1To: wires[i].toId,
              wire2From: wires[j].fromId, wire2To: wires[j].toId,
              x: Math.round(hit.x), y: Math.round(hit.y),
            });
          }
        }
      }
    }
  }
  return crossings;
}

export { MIN_PORT_GAP, MIN_DOGLEG };
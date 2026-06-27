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
  return evenGridHeight(Math.max(AND_GATE_H_BASE, (numInputs + 1) * PORT_SPACING) + labelSpace);
}

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
  const sep = (a: FlatNode, b: FlatNode) => (H.get(a.id)! + H.get(b.id)!) / 2 + VGAP;

  const centre = new Map<string, number>();
  for (let d = 0; d <= maxDepth; d++) {
    const col = columns[d];
    let y = 0;
    for (let i = 0; i < col.length; i++) {
      if (i > 0) y += sep(col[i - 1], col[i]);
      centre.set(col[i].id, y);
    }
  }

  const median = (vals: number[]): number | null => {
    if (vals.length === 0) return null;
    const s = vals.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // Move col[k] toward `desired`, blocked by the nearest higher-or-equal-priority node in
  // that direction, pushing lower-priority nodes to preserve order and minimum gaps.
  const place = (col: FlatNode[], prio: number[], k: number, desired: number) => {
    const cur = centre.get(col[k].id)!;
    if (desired > cur + 0.5) {
      let limit = Infinity, gap = 0;
      for (let j = k + 1; j < col.length; j++) {
        gap += sep(col[j - 1], col[j]);
        if (prio[j] >= prio[k]) { limit = centre.get(col[j].id)! - gap; break; }
      }
      const nc = Math.min(desired, limit);
      if (nc > cur + 0.5) {
        centre.set(col[k].id, nc);
        for (let j = k + 1; j < col.length; j++) {
          const need = centre.get(col[j - 1].id)! + sep(col[j - 1], col[j]);
          if (centre.get(col[j].id)! < need) centre.set(col[j].id, need); else break;
        }
      }
    } else if (desired < cur - 0.5) {
      let limit = -Infinity, gap = 0;
      for (let j = k - 1; j >= 0; j--) {
        gap += sep(col[j], col[j + 1]);
        if (prio[j] >= prio[k]) { limit = centre.get(col[j].id)! + gap; break; }
      }
      const nc = Math.max(desired, limit);
      if (nc < cur - 0.5) {
        centre.set(col[k].id, nc);
        for (let j = k - 1; j >= 0; j--) {
          const need = centre.get(col[j + 1].id)! - sep(col[j], col[j + 1]);
          if (centre.get(col[j].id)! > need) centre.set(col[j].id, need); else break;
        }
      }
    }
  };

  const sweep = (col: FlatNode[], prio: number[], desiredFn: (n: FlatNode) => number | null) => {
    const order = col.map((_, i) => i).sort((a, b) => prio[b] - prio[a]);
    for (const k of order) {
      const d = desiredFn(col[k]);
      if (d != null) place(col, prio, k, d);
    }
  };

  // Downward target: position the node so its input PORTS line up with their sources, not
  // just its centre. A multi-input gate assigns ports to sources in ascending Y at
  // PORT_SPACING intervals, so the centre that aligns port i to source i is
  // source_i - ((i+1)*PORT_SPACING - h/2); the median over inputs minimises residual bends.
  const downTarget = (n: FlatNode): number | null => {
    const srcs = n.inputIds.filter(id => !isFeedback(id)).map(id => centre.get(id)).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    if (srcs.length === 0) return null;
    if (n.kind === 'gate' && n.gateType !== 'NOT' && srcs.length >= 2) {
      const h = H.get(n.id)!;
      return median(srcs.map((s, i) => s - ((i + 1) * PORT_SPACING - h / 2)));
    }
    return median(srcs);
  };
  const upTarget = (n: FlatNode): number | null =>
    median((successors.get(n.id) ?? []).map(id => centre.get(id)).filter((v): v is number => v !== undefined));

  // Up-sweep first (consumers), down-sweep last (sources). Ending on the down-sweep keeps each
  // gate near the inputs it fans in from — short, clean fan-in — while still picking up
  // consumer influence from the up-sweep. (Ending on the up-sweep instead pulls gates toward
  // their consumers and can leave a gate far above its inputs, congesting the fan-in.)
  for (let it = 0; it < 6; it++) {
    for (let d = maxDepth - 1; d >= 0; d--) {
      const col = columns[d];
      sweep(col, col.map(n => (successors.get(n.id) ?? []).length), upTarget);
    }
    for (let d = 1; d <= maxDepth; d++) {
      const col = columns[d];
      sweep(col, col.map(n => n.inputIds.length), downTarget);
    }
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

  // INPUT_ORDER = AUTO (default): reorder input rows by the Sugiyama barycentre method to
  // minimise wire crossings. INPUT_ORDER = DECLARATION: keep inputs in their declared
  // (natural-sorted) order and only propagate gate rows from that fixed input order.
  const barycentreIterations = opts.inputOrder === 'AUTO' ? 3 : 0;
  for (let iteration = 0; iteration < barycentreIterations; iteration++) {
    const sortedInputGroup = [...inputGroup];
    for (const node of sortedInputGroup) {
      const downNodes = Array.from(nodes.values()).filter(n => n.inputIds.includes(node.id));
      if (downNodes.length > 0) {
        const bary = downNodes.reduce((s, n) => s + (rowMap.get(n.id) ?? 0), 0) / downNodes.length;
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

      if (useBars) {
        h = AND_GATE_H_BASE;
        w = isMultiInput ? GATE_W_MULTI : GATE_W;
      } else {
        h = evenGridHeight(Math.max(AND_GATE_H_BASE, (numInputs + 1) * PORT_SPACING));
        w = isMultiInput ? GATE_W_MULTI : GATE_W;
      }

      const inputs: LayoutPort[] = [];
      if (useBars) {
        const portSpacing = Math.round(h / 3 / GRID) * GRID;
        for (let i = 0; i < Math.min(2, numInputs); i++) {
          const portY = absY + (i + 1) * portSpacing;
          inputs.push({ name: `in_${i}`, absX: absX, absY: portY });
        }
        for (let i = 2; i < numInputs; i++) {
          const spacing = (h - 2 * AND_GATE_H_BASE / 3) / (numInputs - 1);
          const portY = absY + AND_GATE_H_BASE / 3 + (i - 2) * Math.min(spacing, MIN_PORT_GAP);
          const snappedY = Math.round(portY / GRID) * GRID;
          inputs.push({ name: `in_${i}`, absX: absX - 10, absY: snappedY });
        }
} else {
      for (let i = 0; i < numInputs; i++) {
        const portY = absY + (i + 1) * PORT_SPACING;
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

  for (const node of nodes.values()) {
    if (node.kind !== 'gate' || !node.gateType || node.gateType === 'NOT') continue;
    if (node.inputIds.length < 2) continue;
    const gateNode = nodeMap.get(node.id);
    if (!gateNode || gateNode.inputs.length < 2) continue;

    const sortedInputIds = [...node.inputIds];
    const inputYs = sortedInputIds.map(id => {
      const src = nodeMap.get(id);
      return src?.outputs[0]?.absY ?? Infinity;
    });
    const indexed = sortedInputIds.map((id, i) => ({ id, absY: inputYs[i] }));
    indexed.sort((a, b) => a.absY - b.absY);

    const sourceYs = indexed.map(e => e.absY).filter(y => y !== Infinity);
    if (sourceYs.length === 0) continue;

    const idealYs: number[] = [sourceYs[0]];
    for (let i = 1; i < sourceYs.length; i++) {
      idealYs.push(Math.max(sourceYs[i], idealYs[i - 1] + MIN_PORT_GAP));
    }

    const topPad = MIN_PORT_GAP;
    const bottomPad = MIN_PORT_GAP;
    const requiredTop = idealYs[0] - topPad;
    const requiredBottom = idealYs[idealYs.length - 1] + bottomPad;
    const requiredHeight = requiredBottom - requiredTop;

    const maxExpansion = MIN_PORT_GAP * gateNode.inputs.length;
    if (requiredHeight <= gateNode.height + maxExpansion) {
      gateNode.absY = Math.round(requiredTop / GRID) * GRID;
      gateNode.height = Math.ceil(requiredHeight / GRID) * GRID;
      for (let i = 0; i < indexed.length && i < gateNode.inputs.length; i++) {
        gateNode.inputs[i].absY = Math.round(idealYs[i] / GRID) * GRID;
      }
      recenterOutputs(gateNode);
    }
  }

  for (const node of nodes.values()) {
    if (node.kind !== 'gate' || !node.gateType || node.gateType === 'NOT') continue;
    if (node.inputIds.length < 2) continue;
    const gateNode = nodeMap.get(node.id);
    if (!gateNode || gateNode.inputs.length < 2) continue;

    const sortedInputIds = [...node.inputIds];
    const inputYs = sortedInputIds.map(id => {
      const src = nodeMap.get(id);
      return src?.outputs[0]?.absY ?? Infinity;
    });
    const indexed = sortedInputIds.map((id, i) => ({ id, absY: inputYs[i] }));
    indexed.sort((a, b) => a.absY - b.absY);
    const sourceYs = indexed.map(e => e.absY).filter(y => y !== Infinity);

    const currentPortYs = gateNode.inputs.map(p => p.absY);
    const expanded = sourceYs.length === currentPortYs.length &&
      sourceYs.every((sy, i) => Math.abs(sy - currentPortYs[i]) < 1);
    if (expanded) continue;

    const h = gateNode.height;
    const n = gateNode.inputs.length;
    const originalAbsY = gateNode.absY;

    function smallDoglegScore(delta: number): number {
      let score = 0;
      for (let i = 0; i < sourceYs.length && i < n; i++) {
        const portY = originalAbsY + delta + (i + 1) * h / (n + 1);
        const diff = Math.abs(sourceYs[i] - portY);
        if (diff >= 1 && diff < MIN_DOGLEG) {
          score += (MIN_DOGLEG - diff) * (MIN_DOGLEG - diff);
        }
      }
      return score;
    }

    let bestDelta = 0;
    let bestScore = smallDoglegScore(0);
    for (let delta = -MIN_DOGLEG; delta <= MIN_DOGLEG; delta += GRID) {
      const score = smallDoglegScore(delta);
      if (score < bestScore || (score === bestScore && Math.abs(delta) < Math.abs(bestDelta))) {
        bestScore = score;
        bestDelta = delta;
      }
    }

    if (Math.abs(bestDelta) >= GRID) {
      gateNode.absY += bestDelta;
      for (const port of gateNode.inputs) {
        port.absY += bestDelta;
      }
      if (gateNode.outputs.length > 0) {
        gateNode.outputs[0].absY += bestDelta;
      }
    }
  }

  // Dogleg enforcement: ensure no wire has 0 < |sourceY - portY| < MIN_DOGLEG.
  // For any input where this constraint is violated, expand the gate to accommodate
  // the port at the source Y position (straight-through) or at source Y ± MIN_DOGLEG.
  for (const node of nodes.values()) {
    if (node.kind !== 'gate' || !node.gateType || node.gateType === 'NOT') continue;
    if (node.inputIds.length < 2) continue;
    const gateNode = nodeMap.get(node.id);
    if (!gateNode || gateNode.inputs.length < 2) continue;

    const sortedInputIds = [...node.inputIds];
    const inputYs = sortedInputIds.map(id => {
      const src = nodeMap.get(id);
      return src?.outputs[0]?.absY ?? Infinity;
    });
    const indexed = sortedInputIds.map((id, i) => ({ id, absY: inputYs[i] }));
    indexed.sort((a, b) => a.absY - b.absY);
    const sourceYs = indexed.map(e => e.absY).filter(y => y !== Infinity);

    let needsExpansion = false;
    for (let i = 0; i < sourceYs.length && i < gateNode.inputs.length; i++) {
      const diff = Math.abs(sourceYs[i] - gateNode.inputs[i].absY);
      if (diff >= 1 && diff < MIN_DOGLEG) {
        needsExpansion = true;
        break;
      }
    }

    if (!needsExpansion) continue;

    // Re-expand: place ports at ideal Y positions with MIN_PORT_GAP between adjacent ports,
    // preferring source Y positions where possible. When a port can't sit on its source (the gap
    // to the previous port pushes it down), keep it at least MIN_DOGLEG away so its wire is a
    // clean Z rather than a small jog — never leave it in the sub-MIN_DOGLEG zone.
    const idealYs: number[] = [sourceYs[0]];
    for (let i = 1; i < sourceYs.length; i++) {
      const minByGap = idealYs[i - 1] + MIN_PORT_GAP;
      let y = Math.max(sourceYs[i], minByGap);
      if (y > sourceYs[i] && y < sourceYs[i] + MIN_DOGLEG) y = Math.max(minByGap, sourceYs[i] + MIN_DOGLEG);
      idealYs.push(y);
    }

    const topPad = MIN_PORT_GAP;
    const bottomPad = MIN_PORT_GAP;
    const requiredTop = idealYs[0] - topPad;
    const requiredBottom = idealYs[idealYs.length - 1] + bottomPad;
    const requiredHeight = requiredBottom - requiredTop;

    const maxExpansion = MIN_DOGLEG * gateNode.inputs.length;
    if (requiredHeight <= gateNode.height + maxExpansion) {
      gateNode.absY = Math.round(requiredTop / GRID) * GRID;
      gateNode.height = Math.ceil(requiredHeight / GRID) * GRID;
      for (let i = 0; i < indexed.length && i < gateNode.inputs.length; i++) {
        gateNode.inputs[i].absY = Math.round(idealYs[i] / GRID) * GRID;
      }
      recenterOutputs(gateNode);
    } else {
      const currentYs = gateNode.inputs.map(p => p.absY);
      for (let i = 0; i < sourceYs.length && i < gateNode.inputs.length; i++) {
        const diff = Math.abs(sourceYs[i] - currentYs[i]);
        if (diff >= 1 && diff < MIN_DOGLEG) {
          const candidateY = Math.round(sourceYs[i] / GRID) * GRID;
          const prevY = i > 0 ? gateNode.inputs[i - 1].absY : gateNode.absY;
          const nextY = i < gateNode.inputs.length - 1 ? gateNode.inputs[i + 1].absY : gateNode.absY + gateNode.height;
          if (candidateY - prevY >= MIN_PORT_GAP && nextY - candidateY >= MIN_PORT_GAP) {
            gateNode.inputs[i].absY = candidateY;
          } else {
            if (candidateY > currentYs[i]) {
              gateNode.inputs[i].absY = Math.round((sourceYs[i] + MIN_DOGLEG) / GRID) * GRID;
            } else {
              gateNode.inputs[i].absY = Math.round((sourceYs[i] - MIN_DOGLEG) / GRID) * GRID;
            }
          }
        }
      }
    }
  }

  // Re-align output nodes after all gate position adjustments
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

  // Position output nodes in a single ordering pass per column.
  //   OUTPUT_ORDER = DECLARATION (default): outputs keep declared order (O1, O2, ... top
  //     to bottom), each aligned to its source Y where possible.
  //   OUTPUT_ORDER = AUTO: outputs are reordered by their source gate's output Y, which
  //     lets output wires fan out without crossing.
  // Within each column, outputs are placed greedily in the chosen order, each at its
  // source Y (straight wire) or pushed down just enough to clear the previous one. Any
  // push is kept >= MIN_DOGLEG so wires never form a small dogleg.
  {
    const declIndex = new Map<string, number>();
    let di = 0;
    for (const node of nodes.values()) if (node.kind === 'output') declIndex.set(node.id, di++);

    const outById = (id: string) => nodeMap.get(id)!;
    const sourceY = (o: LayoutNode) => {
      const srcId = nodes.get(o.id)?.inputIds[0];
      const src = srcId ? nodeMap.get(srcId) : undefined;
      return src?.outputs[0] ? Math.round(src.outputs[0].absY / GRID) * GRID : o.absY + o.height / 2;
    };
    const sourceDepth = (o: LayoutNode) => {
      const srcId = nodes.get(o.id)?.inputIds[0];
      return srcId ? nodes.get(srcId)?.depth ?? 0 : 0;
    };

    const cols = new Map<number, LayoutNode[]>();
    for (const n of layoutNodes) {
      if (n.gateType !== 'OUTPUT') continue;
      const arr = cols.get(n.absX) ?? [];
      arr.push(n);
      cols.set(n.absX, arr);
    }

    for (const outs of cols.values()) {
      // AUTO orders outputs by source Y; on a tie, the output with the DEEPER source (its wire
      // is short and can run straight) takes the slot, so a shallower-source output — whose
      // wire must detour around the deeper gate — is offset to a clear side rather than
      // crossing it (e.g. A·B vs its NAND A·B̄ both driven off the same AND column).
      outs.sort((a, b) =>
        opts.outputOrder === 'AUTO'
          ? sourceY(a) - sourceY(b) || sourceDepth(b) - sourceDepth(a) || declIndex.get(a.id)! - declIndex.get(b.id)!
          : declIndex.get(a.id)! - declIndex.get(b.id)!,
      );
      const minGap = 40; // centre-to-centre clearance between stacked output labels
      let prevCenter = -Infinity;
      for (const o of outs) {
        const want = sourceY(o);
        let center = Math.max(want, prevCenter + minGap);
        // Keep any deviation from the source Y at 0 or >= MIN_DOGLEG (never a small jog).
        if (center - want > 0 && center - want < MIN_DOGLEG) center = want + MIN_DOGLEG;
        center = Math.round(center / GRID) * GRID;
        o.absY = Math.round((center - o.height / 2) / GRID) * GRID;
        o.inputs[0].absY = center;
        prevCenter = center;
      }
    }
  }

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

  // Kill residual small doglegs. Each input port has exactly one source, so a port sitting
  // within MIN_DOGLEG of (but not on) its source Y leaves an ugly small jog. Prefer to fix
  // this by shifting the WHOLE gate (keeping the port gaps intact) by a delta that aligns
  // one port without leaving any other port with a small dogleg. Only if no such shift
  // exists do we nudge a single port, and even then only when it preserves the minimum
  // PORT_SPACING gap to its neighbours.
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

  // Fine-alignment for function blocks and outputs. Blocks have fixed, asymmetric ports and are
  // skipped by the gate-expansion passes, so the coordinate assignment can leave a small (<
  // MIN_DOGLEG) jog on a block input; outputs can likewise sit a few px off their driver. Shift
  // the node (and its ports) to straighten — for a 2-input block, try aligning each input or the
  // symmetric centre, else expand the block so both ports meet their sources — keeping clear of
  // column neighbours.
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

  // Snap each output to its driver's output Y when only a small (<MIN_DOGLEG) jog separates
  // them — run last (after the protected zone nudges gates) so it sees final source positions.
  // Cascade siblings below to preserve MIN_PORT_GAP so the move never crowds the next output.
  for (const col of new Set(layoutNodes.filter(n => n.gateType === 'OUTPUT').map(n => n.absX))) {
    const outs = layoutNodes.filter(n => n.gateType === 'OUTPUT' && n.absX === col).sort((a, b) => a.absY - b.absY);
    for (let i = 0; i < outs.length; i++) {
      const ln = outs[i];
      const fn = nodes.get(ln.id);
      if (!fn || !ln.inputs[0]) continue;
      const sy = blkSrcY(fn.inputIds[0], fn.inputPorts?.[0]);
      if (sy === undefined) continue;
      const diff = sy - ln.inputs[0].absY;
      if (Math.abs(diff) < 1 || Math.abs(diff) >= MIN_DOGLEG) continue;
      const newY = Math.round(sy / GRID) * GRID;
      // May move up only if clear of the output above; may move down, pushing those below.
      const above = outs[i - 1];
      if (above && newY - (above.inputs[0]?.absY ?? above.absY) < MIN_PORT_GAP - 0.5) continue;
      const d = newY - ln.inputs[0].absY;
      ln.absY += d; if (ln.inputs[0]) ln.inputs[0].absY += d;
      for (let j = i + 1; j < outs.length; j++) {
        const prev = outs[j - 1].inputs[0]?.absY ?? outs[j - 1].absY;
        const cur = outs[j].inputs[0]?.absY ?? outs[j].absY;
        if (cur - prev >= MIN_PORT_GAP - 0.5) break;
        const push = Math.round((MIN_PORT_GAP - (cur - prev)) / GRID) * GRID;
        outs[j].absY += push; if (outs[j].inputs[0]) outs[j].inputs[0].absY += push;
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

  // Balanced-Z pass: slide each wire's single vertical segment toward the midpoint of
  // its free horizontal span, so wires make long runs and turn in open space rather than
  // hugging a gate (which causes late-turn crossings). Each move is validated against gate
  // bodies (kept GATE_CLEARANCE away) and against other-source wires, so it never creates
  // a new gate crossing or an overlapping/parallel collision. If nothing validates the
  // wire keeps its routed position.
  const GATE_CLEARANCE = 15;
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
  function crossesOtherWire(w: LayoutWire, vx: number, vy0: number, vy1: number, hyA: number, hxA0: number, hxA1: number, hyB: number, hxB0: number, hxB1: number): boolean {
    const vyMin = Math.min(vy0, vy1), vyMax = Math.max(vy0, vy1);
    for (const o of wires) {
      if (o === w || o.fromId === w.fromId) continue;
      for (let i = 0; i < o.points.length - 1; i++) {
        const a = o.points[i], b = o.points[i + 1];
        if (Math.abs(a.y - b.y) < 0.5) { // other horizontal: crosses our vertical?
          const oxMin = Math.min(a.x, b.x), oxMax = Math.max(a.x, b.x);
          if (vx > oxMin - 0.5 && vx < oxMax + 0.5 && a.y > vyMin - 0.5 && a.y < vyMax + 0.5) return true;
        } else if (Math.abs(a.x - b.x) < 0.5) { // other vertical: overlaps ours / crosses our horizontals?
          const oyMin = Math.min(a.y, b.y), oyMax = Math.max(a.y, b.y);
          if (Math.abs(a.x - vx) < GRID && oyMax > vyMin - 0.5 && oyMin < vyMax + 0.5) return true;
          if (a.x > Math.min(hxA0, hxA1) - 0.5 && a.x < Math.max(hxA0, hxA1) + 0.5 && hyA > oyMin - 0.5 && hyA < oyMax + 0.5) return true;
          if (a.x > Math.min(hxB0, hxB1) - 0.5 && a.x < Math.max(hxB0, hxB1) + 0.5 && hyB > oyMin - 0.5 && hyB < oyMax + 0.5) return true;
        }
      }
    }
    return false;
  }

  for (const w of wires) {
    const p = w.points;
    let vi = -1, vcount = 0;
    for (let i = 0; i < p.length - 1; i++) {
      if (Math.abs(p[i].x - p[i + 1].x) < 0.5 && Math.abs(p[i].y - p[i + 1].y) >= GRID) { vi = i; vcount++; }
    }
    if (vcount !== 1 || vi <= 0 || vi + 2 >= p.length) continue;            // need H–V–H
    if (Math.abs(p[vi - 1].y - p[vi].y) > 0.5) continue;                    // segment before V is horizontal
    if (Math.abs(p[vi + 1].y - p[vi + 2].y) > 0.5) continue;                // segment after V is horizontal
    const sourceX = p[0].x, destX = p[p.length - 1].x;
    const yA = p[vi].y, yB = p[vi + 1].y;
    const mid = Math.round((sourceX + destX) / 2 / GRID) * GRID;
    const lo = Math.round((Math.min(sourceX, destX) + 15) / GRID) * GRID;
    const hi = Math.round((Math.max(sourceX, destX) - 15) / GRID) * GRID;
    const cands: number[] = [];
    for (let x = lo; x <= hi; x += GRID) cands.push(x);
    cands.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    // Pick the valid channel closest to the midpoint, but strongly prefer one that also keeps
    // clear (>= SPREAD) of other nets' parallel verticals so wires read as separate tracks
    // rather than a cramped 5px bundle.
    const SPREAD = 3 * GRID;
    const yMin = Math.min(yA, yB), yMax = Math.max(yA, yB);
    const tooClose = (x: number) => wires.some(o => o.fromId !== w.fromId && o.points.some((pt, k) =>
      k < o.points.length - 1 && Math.abs(pt.x - o.points[k + 1].x) < 0.5 &&
      Math.abs(pt.x - x) > 0.5 && Math.abs(pt.x - x) < SPREAD &&
      Math.max(pt.y, o.points[k + 1].y) > yMin - 0.5 && Math.min(pt.y, o.points[k + 1].y) < yMax + 0.5));
    // Candidates are ordered by distance from the midpoint, so the first valid channel that
    // is also spread-clear is optimal — take it and stop. If none is spread-clear, fall back
    // to the closest valid channel. (Early exit keeps this cheap on big fan-in.)
    let chosen = -1, firstValid = -1;
    for (const x of cands) {
      if (!vGateClear(x, yA, yB)) continue;
      if (!hGateClear(yA, sourceX, x, w.fromId)) continue;
      if (!hGateClear(yB, x, destX, w.toId)) continue;
      if (crossesOtherWire(w, x, yA, yB, yA, sourceX, x, yB, x, destX)) continue;
      if (firstValid < 0) firstValid = x;
      if (!tooClose(x)) { chosen = x; break; }
    }
    const finalX = chosen >= 0 ? chosen : firstValid >= 0 ? firstValid : p[vi].x;
    p[vi].x = finalX; p[vi + 1].x = finalX;
  }

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
    const fanSet = new Set(fanWires);
    const channelOk = (w: LayoutWire, channelX: number, srcX: number, srcY: number, portX: number, portY: number) => {
      if (!vGateClear(channelX, srcY, portY)) return false;
      if (!hGateClear(srcY, srcX, channelX, w.fromId)) return false;
      if (!hGateClear(portY, channelX, portX, w.toId)) return false;
      const vyMin = Math.min(srcY, portY), vyMax = Math.max(srcY, portY);
      for (const o of wires) {
        if (o === w || o.fromId === w.fromId || fanSet.has(o)) continue;
        for (let k = 0; k < o.points.length - 1; k++) {
          const a = o.points[k], b = o.points[k + 1];
          if (Math.abs(a.x - b.x) < 0.5) { // other vertical: too close to our channel?
            // Keep a real gap (not just non-overlap) from another net's parallel vertical —
            // e.g. a neighbouring gate's fan-in channel in the same column — so the two read
            // as separate tracks rather than a cramped 5px bundle.
            if (Math.abs(a.x - channelX) < 2 * GRID &&
                Math.max(a.y, b.y) > vyMin - 0.5 && Math.min(a.y, b.y) < vyMax + 0.5) return false;
          } else if (Math.abs(a.y - b.y) < 0.5) { // other horizontal: cross our channel?
            if (a.y > vyMin - 0.5 && a.y < vyMax + 0.5 &&
                channelX > Math.min(a.x, b.x) - 0.5 && channelX < Math.max(a.x, b.x) + 0.5) return false;
          }
        }
      }
      return true;
    };

    // All-or-nothing per group: compute every nested channel, and only apply them if all are
    // valid and mutually distinct. Otherwise leave the group untouched so we never trade one
    // problem for another.
    const place = (group: LayoutWire[]) => {
      const plan: { w: LayoutWire; cx: number; srcX: number; srcY: number; portX: number; portY: number }[] = [];
      const used = new Set<number>();
      // Nesting step: FANIN_SPACING normally, but tightened so a large fan-in still fits its
      // channels in the room left of the gate (otherwise the deep channels clamp onto the same X
      // and the all-or-nothing fails, leaving the wires as crossing-heavy raw routes).
      const groupMinX = Math.max(0, ...group.map(w => Math.round((w.points[0].x + MIN_DOGLEG) / GRID) * GRID));
      const room = gate.absX - GATE_CLEARANCE - groupMinX;
      const step = group.length > 1
        ? Math.max(GRID, Math.min(FANIN_SPACING, Math.floor(room / (group.length - 1) / GRID) * GRID))
        : FANIN_SPACING;
      for (let i = 0; i < group.length; i++) {
        const w = group[i];
        const srcX = w.points[0].x, srcY = w.points[0].y;
        const e = lastPt(w), portX = e.x, portY = e.y;
        // i = 0 (most extreme source) turns closest to the gate; deeper indices nest left.
        let cx = gate.absX - GATE_CLEARANCE - i * step;
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
    place(above);
    place(below);
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
    // A move is rejected if the relocated vertical or its peel-off horizontal would touch a
    // wire from a different source (same-source overlap is fine — that's the shared trunk).
    const moveClear = (self: LayoutWire, sharedX: number) => {
      const vyMin = Math.min(self.points[1].y, self.points[2].y);
      const vyMax = Math.max(self.points[1].y, self.points[2].y);
      const hy = self.points[3].y, hx0 = Math.min(sharedX, self.points[3].x), hx1 = Math.max(sharedX, self.points[3].x);
      for (const o of wires) {
        if (o.fromId === self.fromId) continue;
        for (let k = 0; k < o.points.length - 1; k++) {
          const a = o.points[k], b = o.points[k + 1];
          if (Math.abs(a.x - b.x) < 0.5) { // other vertical
            if (Math.abs(a.x - sharedX) < GRID && Math.max(a.y, b.y) > vyMin - 0.5 && Math.min(a.y, b.y) < vyMax + 0.5) return false;
          } else if (Math.abs(a.y - b.y) < 0.5) { // other horizontal vs our vertical or peel-off
            if (a.y > vyMin - 0.5 && a.y < vyMax + 0.5 && sharedX > Math.min(a.x, b.x) - 0.5 && sharedX < Math.max(a.x, b.x) + 0.5) return false;
            if (Math.abs(a.y - hy) < 0.5 && Math.max(a.x, b.x) > hx0 - 0.5 && Math.min(a.x, b.x) < hx1 + 0.5) return false;
          }
        }
      }
      return true;
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
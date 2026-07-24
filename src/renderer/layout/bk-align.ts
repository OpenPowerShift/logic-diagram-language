// Brandes–Köpf-style block straightening (issue #15). The layout's per-type placement passes bend a
// gate's spine because they never reach a fixpoint over the multi-way constraint between a gate, its
// branch inputs and their shared column. This module solves that globally: it groups nodes whose
// connecting wire we want dead-straight into rigid "blocks" (a block is a straight signal chain —
// input→FB→TIMER→AND→output — that must move as one), then compacts each column so a block keeps its
// straight line while lower-priority nodes are *pushed to make room* rather than colliding.
//
// It is deliberately a pure function over a minimal node model so it is unit-testable in isolation and
// carries no dependency on the realized SVG geometry. `placement.ts` builds the model from the placed
// nodes, applies the returned centres as rigid shifts, and keeps the result only if a quality check
// (no new sub-MIN jog / body overlap / height growth) passes — so BK can never break an invariant.

export interface BkNode {
  id: string;
  center: number;          // current vertical centre
  height: number;          // body height (for separation)
  col: number;             // column key (x); nodes in the same column must not overlap
  weight: number;          // dominance weight (upstream cone size) — heavier blocks hold their line
  domId?: string;          // the dominant driver this node wants to be straight with (same block)
  domRel?: number;         // desired (center[this] - center[domId]) that draws that wire straight
}

const PAVA_GAP = 25; // min body-to-body clearance folded into separation (≈ MIN_PORT_GAP)

// Weighted isotonic regression (Pool Adjacent Violators): the exact L2 optimum of
// min Σ wᵢ(xᵢ − tᵢ)² subject to x non-decreasing. Same routine the barycentre solver uses.
function pava(t: number[], w: number[]): number[] {
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
}

// Offset union–find: each node stores its target centre RELATIVE to its block root, so unioning two
// nodes with a fixed centre difference builds a rigid block whose members keep their straight-line
// offsets no matter where the block ends up.
class OffsetDSU {
  parent = new Map<string, string>();
  off = new Map<string, number>();   // off[x] = targetCentre[x] − targetCentre[root]
  make(id: string) { if (!this.parent.has(id)) { this.parent.set(id, id); this.off.set(id, 0); } }
  find(x: string): { root: string; off: number } {
    const p = this.parent.get(x)!;
    if (p === x) return { root: x, off: 0 };
    const r = this.find(p);
    const o = this.off.get(x)! + r.off;
    this.parent.set(x, r.root); this.off.set(x, o);
    return { root: r.root, off: o };
  }
  // Union so that targetCentre[x] − targetCentre[y] === d.
  union(x: string, y: string, d: number) {
    const fx = this.find(x), fy = this.find(y);
    if (fx.root === fy.root) return;                 // keep the first (higher-priority) constraint
    this.parent.set(fy.root, fx.root);
    this.off.set(fy.root, fx.off - fy.off - d);      // fx.off − (off[fy.root] + fy.off) === d
  }
}

// Compute a straightened centre for every node. Pure: does not mutate inputs.
export function bkCompact(nodes: BkNode[], iters = 14): Map<string, number> {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const dsu = new OffsetDSU();
  for (const n of nodes) dsu.make(n.id);
  // Build blocks: link each node to its dominant driver (heavier priority processed first so the
  // trunk's straight line wins when two constraints on one node conflict).
  for (const n of [...nodes].sort((a, b) => b.weight - a.weight)) {
    if (n.domId !== undefined && n.domRel !== undefined && byId.has(n.domId)) {
      dsu.union(n.id, n.domId, n.domRel);
    }
  }

  const center = new Map(nodes.map(n => [n.id, n.center]));
  const offToRoot = new Map(nodes.map(n => [n.id, dsu.find(n.id).off]));
  const rootOf = new Map(nodes.map(n => [n.id, dsu.find(n.id).root]));

  // Columns, each kept in ascending-centre order (stable node order within a column).
  const cols = new Map<number, BkNode[]>();
  for (const n of nodes) (cols.get(n.col) ?? cols.set(n.col, []).get(n.col)!).push(n);
  for (const arr of cols.values()) arr.sort((a, b) => a.center - b.center);

  for (let it = 0; it < iters; it++) {
    // Block anchor = weight-weighted mean of each member's implied root centre (centre − offset).
    const num = new Map<string, number>(), den = new Map<string, number>();
    for (const n of nodes) {
      const r = rootOf.get(n.id)!;
      const implied = center.get(n.id)! - offToRoot.get(n.id)!;
      num.set(r, (num.get(r) ?? 0) + implied * n.weight);
      den.set(r, (den.get(r) ?? 0) + n.weight);
    }
    const anchor = new Map<string, number>();
    for (const r of num.keys()) anchor.set(r, num.get(r)! / den.get(r)!);

    // Per-column compaction toward each node's block target, subject to non-overlap separation.
    for (const arr of cols.values()) {
      const n = arr.length;
      const G: number[] = [0];
      for (let i = 1; i < n; i++) G[i] = G[i - 1] + (arr[i - 1].height + arr[i].height) / 2 + PAVA_GAP;
      const t: number[] = [], w: number[] = [];
      for (let i = 0; i < n; i++) {
        t.push(anchor.get(rootOf.get(arr[i].id)!)! + offToRoot.get(arr[i].id)! - G[i]);
        w.push(Math.max(1, arr[i].weight));
      }
      const z = pava(t, w);
      for (let i = 0; i < n; i++) center.set(arr[i].id, z[i] + G[i]);
    }
  }
  return center;
}

import type { FlatNode } from '../graph.js';
import type { RenderOptions } from '../../parser/ast.js';
import { naturalCompare } from './geometry.js';

export function crossminOrder(nodes: Map<string, FlatNode>, maxDepth: number, opts: RenderOptions): Map<string, number> {
  const isFeedback = (id: string) => nodes.get(id)?.kind === 'output';
  const fixedPort = (id: string | null) => { const n = id ? nodes.get(id) : undefined; return !!n?.gateType && !['AND', 'OR', 'NOT', 'DUMMY', 'INPUT', 'OUTPUT'].includes(n.gateType); };
  const layer: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  const depthOf = new Map<string, number>();
  const real = new Set<string>();
  for (const n of nodes.values()) { layer[n.depth].push(n.id); depthOf.set(n.id, n.depth); real.add(n.id); }

  interface E { u: string; v: string; k: number; vReal: string | null; off: number } // off: precomputed portOff
  const edges: E[] = [];
  let dc = 0;
  for (const v of nodes.values()) {
    v.inputIds.forEach((u, k) => {
      if (isFeedback(u)) return;
      const du = depthOf.get(u); if (du === undefined) return;
      if (v.depth - du <= 1) { edges.push({ u, v: v.id, k, vReal: v.id, off: 0 }); return; }
      let prev = u;                                              // long edge → local dummy chain
      for (let d = du + 1; d < v.depth; d++) {
        const did = `cmD${dc++}`; layer[d].push(did); depthOf.set(did, d);
        edges.push({ u: prev, v: did, k: 0, vReal: null, off: 0 }); prev = did;
      }
      edges.push({ u: prev, v: v.id, k, vReal: v.id, off: 0 });
    });
  }
  const edgesFrom: E[][] = Array.from({ length: maxDepth + 1 }, () => []);
  const inAdj = new Map<string, string[]>(), outAdj = new Map<string, string[]>();
  const outE = new Map<string, E[]>(), inE = new Map<string, E[]>();   // edge objects by source / by target (for incremental transpose)
  for (const e of edges) {
    edgesFrom[depthOf.get(e.u)!].push(e);
    (inAdj.get(e.v) ?? inAdj.set(e.v, []).get(e.v)!).push(e.u);
    (outAdj.get(e.u) ?? outAdj.set(e.u, []).get(e.u)!).push(e.v);
    (outE.get(e.u) ?? outE.set(e.u, []).get(e.u)!).push(e);
    (inE.get(e.v) ?? inE.set(e.v, []).get(e.v)!).push(e);
  }
  const pos = new Map<string, number>();
  const reindex = () => { for (const l of layer) l.forEach((id, i) => pos.set(id, i)); };
  const portOff = (e: E) => {
    if (!e.vReal || !fixedPort(e.vReal)) return 0;
    const c = nodes.get(e.vReal)!; if (c.inputIds.length < 2) return 0;
    return (e.k - (c.inputIds.length - 1) / 2) / c.inputIds.length;
  };
  for (const e of edges) e.off = portOff(e);        // static: fold the per-edge port offset once
  const countLayer = (d: number) => {
    const es = edgesFrom[d]; let c = 0;
    for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
      const du = pos.get(es[i].u)! - pos.get(es[j].u)!;
      const dv = (pos.get(es[i].v)! + es[i].off) - (pos.get(es[j].v)! + es[j].off);
      if (du * dv < -1e-9) c++;
    }
    return c;
  };
  const countAll = () => { let c = 0; for (let d = 0; d < maxDepth; d++) c += countLayer(d); return c; };
  const median = (xs: number[]) => { xs.sort((a, b) => a - b); const m = xs.length >> 1; return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2; };
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  // Port-aware barycenter: an edge into a fixed-port consumer (S/R latch, TIMER, FB) attaches at a
  // specific pin, offset from the node centre by portOff. Fold that offset into the neighbour position
  // so a producer feeding the *top* pin sorts above one feeding the *bottom* pin — matching the crossing
  // model in countLayer. Keyed both directions: fwd = producer→consumer (+off), bwd = consumer→producer (-off).
  const offFwd = new Map<string, number>(), offBwd = new Map<string, number>();
  for (const e of edges) { const o = portOff(e); if (o !== 0) { offFwd.set(`${e.u} ${e.v}`, o); offBwd.set(`${e.v} ${e.u}`, o); } }
  const sweep = (d: number, adj: Map<string, string[]>, useMean: boolean, off: Map<string, number>) => {
    const key = new Map<string, number>();
    for (const id of layer[d]) {
      const ns = adj.get(id) ?? [];
      const ps = ns.map(x => pos.get(x)! + (off === offFwd ? (off.get(`${id} ${x}`) ?? 0) : -(off.get(`${id} ${x}`) ?? 0)));
      key.set(id, ps.length ? (useMean ? mean(ps) : median(ps)) : pos.get(id)!);
    }
    layer[d] = layer[d].map((id, i) => ({ id, i })).sort((a, b) => (key.get(a.id)! - key.get(b.id)!) || (a.i - b.i)).map(x => x.id);
    reindex();
  };
  // Crossing change from swapping the two ADJACENT nodes a,b in layer d (a currently at the lower row,
  // i.e. just before b). Returns crossings(after) − crossings(before). Swapping two adjacent nodes only
  // reorders edges INCIDENT to a and b — every other edge pair keeps its relative order (a third node is
  // ≥1 row away, and the port offsets are bounded to (−0.5,0.5), so no third-node dv can cross zero from
  // a one-row shift). So the whole-layer O(E²) recount collapses to an O(deg(a)·deg(b)) delta over just
  // the a×b edge pairs — turning transpose from the crossmin bottleneck into a near-linear pass (#23).
  // Mirrors countLayer's crossing test (du·dv < −1e-9, dv folds in the per-edge port offset `off`).
  const swapDelta = (d: number, a: string, b: string): number => {
    let delta = 0;
    // Outgoing edges (layer d → d+1, countLayer(d)): the a↔b order flips du from −1 to +1; the
    // neighbour rows in layer d+1 (hence dv) are untouched by the swap.
    if (d < maxDepth) {
      const ea = outE.get(a), eb = outE.get(b);
      if (ea && eb) for (const e1 of ea) for (const e2 of eb) {
        const dv = (pos.get(e1.v)! + e1.off) - (pos.get(e2.v)! + e2.off);
        if (dv < -1e-9) delta++;          // not crossing before (du=−1), crossing after (du=+1)
        else if (dv > 1e-9) delta--;      // crossing before, not after
      }
    }
    // Incoming edges (layer d−1 → d, countLayer(d−1)): the source rows in layer d−1 (hence du) are
    // untouched; a,b swapping rows changes dv. Before pos(a)=i,pos(b)=i+1 → dv=(off1−off2)−1; after → +1.
    if (d > 0) {
      const ea = inE.get(a), eb = inE.get(b);
      if (ea && eb) for (const e1 of ea) for (const e2 of eb) {
        const du = pos.get(e1.u)! - pos.get(e2.u)!;
        const base = e1.off - e2.off;
        const crossBefore = du * (base - 1) < -1e-9;
        const crossAfter = du * (base + 1) < -1e-9;
        if (crossAfter && !crossBefore) delta++;
        else if (crossBefore && !crossAfter) delta--;
      }
    }
    return delta;
  };
  const transpose = () => {
    for (let g = 0; g < 6; g++) {
      let improved = false;
      for (let d = 0; d <= maxDepth; d++) for (let i = 0; i + 1 < layer[d].length; i++) {
        const a = layer[d][i], b = layer[d][i + 1];
        if (swapDelta(d, a, b) < 0) {                             // strictly fewer crossings → keep the swap
          layer[d][i] = b; layer[d][i + 1] = a; pos.set(b, i); pos.set(a, i + 1);
          improved = true;
        }
      }
      if (!improved) break;
    }
  };

  layer[0].sort((a, b) => naturalCompare(nodes.get(a)?.label ?? a, nodes.get(b)?.label ?? b));
  reindex();
  for (let d = 1; d <= maxDepth; d++) sweep(d, inAdj, false, offBwd);
  let best = layer.map(l => l.slice()), bestCr = countAll();
  const record = () => { const cr = countAll(); if (cr < bestCr) { bestCr = cr; best = layer.map(l => l.slice()); } };
  const rounds = opts.inputOrder === 'DECLARATION' ? 0 : 24;
  for (let r = 0; r < rounds && bestCr > 0; r++) {
    const useMean = r % 2 === 1;
    for (let d = 1; d <= maxDepth; d++) sweep(d, inAdj, useMean, offBwd); transpose(); record();
    for (let d = maxDepth - 1; d >= 0; d--) sweep(d, outAdj, useMean, offFwd); transpose(); record();
  }
  // Fan-in contiguity: keep each gate's single-consumer inputs together (the combinatorial optimum
  // can interleave independent chains — cheap combinatorially but crossing once drawn).
  const soleC = (id: string) => { const cs = outAdj.get(id) ?? []; return cs.length === 1 ? cs[0] : id; };
  const bpos = new Map<string, number>(); best[0].forEach((id, i) => bpos.set(id, i));
  const grp = new Map<string, string[]>();
  for (const id of best[0]) { const k = soleC(id); (grp.get(k) ?? grp.set(k, []).get(k)!).push(id); }
  for (let d = 0; d <= maxDepth; d++) layer[d] = best[d];
  layer[0] = [...grp.values()].sort((a, b) => Math.min(...a.map(x => bpos.get(x)!)) - Math.min(...b.map(x => bpos.get(x)!)))
    .map(g => g.sort((a, b) => bpos.get(a)! - bpos.get(b)!)).flat();
  reindex();
  for (let d = 1; d <= maxDepth; d++) sweep(d, inAdj, false, offBwd);
  transpose();

  const rowMap = new Map<string, number>();
  for (let d = 0; d <= maxDepth; d++) { let r = 0; for (const id of layer[d]) if (real.has(id)) rowMap.set(id, r++); }
  return rowMap;
}

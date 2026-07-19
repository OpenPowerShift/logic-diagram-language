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

  interface E { u: string; v: string; k: number; vReal: string | null; } // vReal: fixed-port consumer for port offset
  const edges: E[] = [];
  let dc = 0;
  for (const v of nodes.values()) {
    v.inputIds.forEach((u, k) => {
      if (isFeedback(u)) return;
      const du = depthOf.get(u); if (du === undefined) return;
      if (v.depth - du <= 1) { edges.push({ u, v: v.id, k, vReal: v.id }); return; }
      let prev = u;                                              // long edge → local dummy chain
      for (let d = du + 1; d < v.depth; d++) {
        const did = `cmD${dc++}`; layer[d].push(did); depthOf.set(did, d);
        edges.push({ u: prev, v: did, k: 0, vReal: null }); prev = did;
      }
      edges.push({ u: prev, v: v.id, k, vReal: v.id });
    });
  }
  const edgesFrom: E[][] = Array.from({ length: maxDepth + 1 }, () => []);
  const inAdj = new Map<string, string[]>(), outAdj = new Map<string, string[]>();
  for (const e of edges) {
    edgesFrom[depthOf.get(e.u)!].push(e);
    (inAdj.get(e.v) ?? inAdj.set(e.v, []).get(e.v)!).push(e.u);
    (outAdj.get(e.u) ?? outAdj.set(e.u, []).get(e.u)!).push(e.v);
  }
  const pos = new Map<string, number>();
  const reindex = () => { for (const l of layer) l.forEach((id, i) => pos.set(id, i)); };
  const portOff = (e: E) => {
    if (!e.vReal || !fixedPort(e.vReal)) return 0;
    const c = nodes.get(e.vReal)!; if (c.inputIds.length < 2) return 0;
    return (e.k - (c.inputIds.length - 1) / 2) / c.inputIds.length;
  };
  const countLayer = (d: number) => {
    const es = edgesFrom[d]; let c = 0;
    for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
      const du = pos.get(es[i].u)! - pos.get(es[j].u)!;
      const dv = (pos.get(es[i].v)! + portOff(es[i])) - (pos.get(es[j].v)! + portOff(es[j]));
      if (du * dv < -1e-9) c++;
    }
    return c;
  };
  const countAll = () => { let c = 0; for (let d = 0; d < maxDepth; d++) c += countLayer(d); return c; };
  const median = (xs: number[]) => { xs.sort((a, b) => a - b); const m = xs.length >> 1; return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2; };
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const sweep = (d: number, adj: Map<string, string[]>, useMean: boolean) => {
    const key = new Map<string, number>();
    for (const id of layer[d]) {
      const ps = (adj.get(id) ?? []).map(x => pos.get(x)!);
      key.set(id, ps.length ? (useMean ? mean(ps) : median(ps)) : pos.get(id)!);
    }
    layer[d] = layer[d].map((id, i) => ({ id, i })).sort((a, b) => (key.get(a.id)! - key.get(b.id)!) || (a.i - b.i)).map(x => x.id);
    reindex();
  };
  const transpose = () => {
    for (let g = 0; g < 6; g++) {
      let improved = false;
      for (let d = 0; d <= maxDepth; d++) for (let i = 0; i + 1 < layer[d].length; i++) {
        const local = () => (d > 0 ? countLayer(d - 1) : 0) + (d < maxDepth ? countLayer(d) : 0);
        const before = local();
        [layer[d][i], layer[d][i + 1]] = [layer[d][i + 1], layer[d][i]]; reindex();
        if (local() < before) improved = true;
        else { [layer[d][i], layer[d][i + 1]] = [layer[d][i + 1], layer[d][i]]; reindex(); }
      }
      if (!improved) break;
    }
  };

  layer[0].sort((a, b) => naturalCompare(nodes.get(a)?.label ?? a, nodes.get(b)?.label ?? b));
  reindex();
  for (let d = 1; d <= maxDepth; d++) sweep(d, inAdj, false);
  let best = layer.map(l => l.slice()), bestCr = countAll();
  const record = () => { const cr = countAll(); if (cr < bestCr) { bestCr = cr; best = layer.map(l => l.slice()); } };
  const rounds = opts.inputOrder === 'DECLARATION' ? 0 : 24;
  for (let r = 0; r < rounds && bestCr > 0; r++) {
    const useMean = r % 2 === 1;
    for (let d = 1; d <= maxDepth; d++) sweep(d, inAdj, useMean); transpose(); record();
    for (let d = maxDepth - 1; d >= 0; d--) sweep(d, outAdj, useMean); transpose(); record();
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
  for (let d = 1; d <= maxDepth; d++) sweep(d, inAdj, false);
  transpose();

  const rowMap = new Map<string, number>();
  for (let d = 0; d <= maxDepth; d++) { let r = 0; for (const id of layer[d]) if (real.has(id)) rowMap.set(id, r++); }
  return rowMap;
}

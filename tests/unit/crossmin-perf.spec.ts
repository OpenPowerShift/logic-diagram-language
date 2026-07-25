import { describe, it, expect } from 'vitest';
import { crossminOrder } from '../../src/renderer/layout/crossmin.js';
import type { FlatNode } from '../../src/renderer/graph.js';
import { DEFAULT_OPTIONS } from '../../src/parser/ast.js';

// Regression guard for #44/#23: crossminOrder's `transpose` used to validate every candidate adjacent
// swap by recounting the whole affected layers with countLayer (O(edges²)) — twice per swap, O(V) swaps
// per pass — making it O(N³). On wide diagrams the crossmin ORDERING alone was ~40% of layout time
// (n=30: 4.3s). The fix computes the swap's crossing change as an O(deg·deg) delta over only the two
// swapped nodes' edge bundles (exact: no other edge pair's order changes), which is byte-identical yet
// collapses the phase (n=30: 4275ms -> ~19ms).
//
// We time crossminOrder in ISOLATION (a synthetic layered graph) so A* routing doesn't mask it, and
// assert the SCALING RATIO measured back-to-back. Doubling the width (W=40 -> 80) at fixed depth cost
// ~cubically before and ~quadratically after; a threshold of 6 fails a cubic regression (~8x) while
// clearing the quadratic reality (~4x) with margin.
//
// Graph: a shuffled bipartite-ish stack — each of W consumers at every deeper layer pulls two sources
// from a rotated position in the previous layer, which forces heavy transpose activity (many reducible
// crossings) rather than a trivially-sorted order.
const build = (W: number, D: number): Map<string, FlatNode> => {
  const nodes = new Map<string, FlatNode>();
  for (let w = 0; w < W; w++) nodes.set(`n0_${w}`, { id: `n0_${w}`, kind: 'input', depth: 0, inputIds: [] });
  for (let d = 1; d <= D; d++) {
    for (let w = 0; w < W; w++) {
      const a = (w * 7 + d) % W, b = (w * 13 + 3 * d) % W;       // rotated picks → crossings to resolve
      nodes.set(`n${d}_${w}`, { id: `n${d}_${w}`, kind: 'gate', gateType: 'AND', depth: d, inputIds: [`n${d - 1}_${a}`, `n${d - 1}_${b}`] });
    }
  }
  return nodes;
};
const timeCrossmin = (W: number, D: number): number => {
  const nodes = build(W, D);
  let best = Infinity;
  for (let r = 0; r < 3; r++) { const t = performance.now(); crossminOrder(nodes, D, DEFAULT_OPTIONS); best = Math.min(best, performance.now() - t); }
  return best;
};

describe('crossminOrder scaling (#44)', () => {
  it('transpose stays sub-cubic as the layer widens', () => {
    timeCrossmin(40, 4); // warm up JIT
    const t40 = timeCrossmin(40, 4);
    const t80 = timeCrossmin(80, 4);
    const ratio = t80 / t40;
    // Old cubic transpose ≈ 8x for a doubling; fixed ≈ 4x. Fail well before a cubic regression.
    expect(ratio).toBeLessThan(6);
  }, 30000);
});

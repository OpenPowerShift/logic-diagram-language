import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram } from '../../src/renderer/layout.js';
import { resolveOptions } from '../../src/parser/ast.js';

// Regression guard for #42: symmetriseSmallGates used to call the whole-diagram findWireCrossings
// (O(segments²)) twice per gate, making the cosmetic mirror-alignment pass O(N³). On wide diagrams it
// dominated layout time — n=40 was ~3.5s with ~2.9s (83%) in this one pass. The fix counts only the
// crossings that INVOLVE the single moved wire (exact: every pair not touching the mover is unchanged),
// dropping the pass to ~O(N²).
//
// The shape below is a stack of independent gate chains that lays out CLEAN on the heuristic ordering
// (0 crossings, so no crossmin/routing blow-up muddies the measurement) yet drives the symmetry pass
// hard (each gate has a mirror-able above/below fan-in). We measure the SCALING RATIO back-to-back in
// one process so machine speed cancels: quadrupling the width (12 -> 48 outputs) cost ~47x under the old
// cubic pass but ~18x once quadratic (the residual >16x is the sub-quadratic place/route floor). A
// threshold of 30 sits between the two with ~60% margin on each side and is robust to timing noise.
const wide = (n: number): string => {
  const lines = ['OPTION OUTPUT_ORDER = AUTO'];
  for (let i = 0; i < n; i++) lines.push(`O${i} = ((A${i} AND B${i}) AND C${i}_0) OR C${i}_1`);
  return lines.join('\n');
};
const timeLayout = (n: number): number => {
  const dg = parse(wide(n)).diagram;
  const opts = resolveOptions(dg.options);
  let best = Infinity;
  for (let r = 0; r < 2; r++) { const t = performance.now(); layoutDiagram(dg, opts); best = Math.min(best, performance.now() - t); }
  return best;
};

describe('symmetriseSmallGates scaling (#42)', () => {
  it('stays sub-cubic as the diagram widens', () => {
    timeLayout(12); // warm up JIT before the measured pair
    const small = timeLayout(12);
    const big = timeLayout(48);
    const ratio = big / small;
    // Old cubic pass ≈ 47x for a 4x widening; fixed quadratic ≈ 18x. Fail well before a cubic regression.
    expect(ratio).toBeLessThan(30);
  }, 30000);
});

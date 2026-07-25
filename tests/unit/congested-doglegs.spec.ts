import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram, MIN_DOGLEG } from '../../src/renderer/layout.js';
import { resolveOptions } from '../../src/parser/ast.js';

// #33: on congested large diagrams the wire-separation contract's no-sub-MIN_DOGLEG guarantee was not
// met. The failure mode is a TERMINAL port-approach stair: a fan-in wire runs up its channel to the gate
// edge, then a small (< MIN_DOGLEG) vertical steps to the port row — because PASS 2's nested fan-in
// reverted to A*'s stair to avoid a crossing, and PASS 5 deliberately leaves the final port-approach jog.
// PASS 10.5 now straightens it (slides the pre-jog run onto the port row, extending the channel), so the
// canonical class is eliminated. Guarded here on a reconvergent "fire-alarm matrix": a wide OR gathers
// many terms, seals via ALARM, and fans back out to per-zone AND gates — dense fan-in that produced the
// stair before the fix.
const fireMatrix = (n: number): string => {
  const lines: string[] = [];
  for (let z = 0; z < n; z++) lines.push(`Z${z} = D${z} OR D${(z + 1) % n} OR D${(z + 2) % n}`);
  lines.push(`ALARM = ${Array.from({ length: n }, (_, z) => `Z${z}`).join(' OR ')}`);
  for (let z = 0; z < n; z++) lines.push(`OUT${z} = ALARM AND Z${z}`);
  return lines.join('\n');
};

const layout = (src: string) => {
  const dg = parse(src).diagram;
  return layoutDiagram(dg, resolveOptions(dg.options));
};

describe('congested-diagram wire contract (#33)', () => {
  const l = layout(fireMatrix(5));

  it('produces no sub-MIN_DOGLEG jogs', () => {
    const offenders: string[] = [];
    for (const w of l.wires) {
      if (w.feedback) continue;
      for (let i = 0; i < w.points.length - 1; i++) {
        const a = w.points[i], b = w.points[i + 1];
        if (Math.abs(a.x - b.x) < 0.5) {
          const len = Math.abs(a.y - b.y);
          if (len >= 0.5 && len < MIN_DOGLEG - 0.01) offenders.push(`${w.fromId}->${w.toId} ${len.toFixed(1)}px`);
        }
      }
    }
    expect(offenders, `sub-min jogs: ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps every wire segment orthogonal (the straightener must not bend a diagonal)', () => {
    for (const w of l.wires) {
      for (let i = 0; i < w.points.length - 1; i++) {
        const a = w.points[i], b = w.points[i + 1];
        expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5, `${w.fromId}->${w.toId} diagonal`).toBe(true);
      }
    }
  });
});

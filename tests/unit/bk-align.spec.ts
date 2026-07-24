import { describe, it, expect } from 'vitest';
import { bkCompact, type BkNode } from '../../src/renderer/layout/bk-align.js';

describe('bkCompact (Brandes–Köpf block straightening)', () => {
  it('aligns a straight chain (domRel 0) to a single line, one node per column', () => {
    const nodes: BkNode[] = [
      { id: 'a', center: 0, height: 20, col: 0, weight: 3 },
      { id: 'b', center: 50, height: 20, col: 1, weight: 2, domId: 'a', domRel: 0 },
      { id: 'c', center: -30, height: 20, col: 2, weight: 1, domId: 'b', domRel: 0 },
    ];
    const out = bkCompact(nodes);
    // All three share one block with zero offset → identical centre (a dead-straight wire).
    expect(out.get('a')!).toBeCloseTo(out.get('b')!, 6);
    expect(out.get('b')!).toBeCloseTo(out.get('c')!, 6);
  });

  it('keeps a fixed non-zero offset straight (port offset case)', () => {
    // b sits 10 below a to draw its port straight; the wire is still straight (diff stays 10).
    const nodes: BkNode[] = [
      { id: 'a', center: 0, height: 20, col: 0, weight: 2 },
      { id: 'b', center: 3, height: 20, col: 1, weight: 1, domId: 'a', domRel: 10 },
    ];
    const out = bkCompact(nodes);
    expect(out.get('b')! - out.get('a')!).toBeCloseTo(10, 6);
  });

  it('pushes two same-column nodes apart to at least the separation', () => {
    const nodes: BkNode[] = [
      { id: 'x', center: 0, height: 20, col: 0, weight: 5 },
      { id: 'y', center: 5, height: 20, col: 0, weight: 1 },
    ];
    const out = bkCompact(nodes);
    const sep = (20 + 20) / 2 + 25;                 // PAVA_GAP folded in
    expect(Math.abs(out.get('y')! - out.get('x')!)).toBeGreaterThanOrEqual(sep - 1e-6);
  });

  it('makes room: straightening a spine pushes a same-column branch clear (snippet-1 shape)', () => {
    // Spine fb→timer→and(+out) must stay straight; the NOT branch shares fb's column and must be
    // pushed clear rather than colliding. Heavy weights on the spine so it holds its line.
    const nodes: BkNode[] = [
      { id: 'fb', center: 130, height: 90, col: 1, weight: 4 },
      { id: 'not', center: 150, height: 40, col: 1, weight: 1, domId: 'lop', domRel: 0 },
      { id: 'lop', center: 150, height: 20, col: 0, weight: 1 },
      { id: 'timer', center: 130, height: 50, col: 2, weight: 3, domId: 'fb', domRel: 0 },
      { id: 'and', center: 90, height: 50, col: 3, weight: 2, domId: 'timer', domRel: 10 },
    ];
    const out = bkCompact(nodes);
    // Spine straight: timer on fb's line; and offset by its port (+10).
    expect(Math.abs(out.get('timer')! - out.get('fb')!)).toBeLessThan(1);          // straight after grid snap
    expect(Math.abs((out.get('and')! - out.get('timer')!) - 10)).toBeLessThan(1);
    // Branch cleared out of fb's body (no overlap) in the shared column.
    expect(Math.abs(out.get('not')! - out.get('fb')!)).toBeGreaterThanOrEqual((90 + 40) / 2 - 1e-6);
  });
});

import type { LayoutResult, LayoutWire } from './types.js';
import { GRID, MIN_DOGLEG, MIN_WIRE_SPACING } from './types.js';
import { findWireCrossings } from './crossings.js';

export function symmetriseSmallGates(l: LayoutResult): void {
  const crossings = () => findWireCrossings(l.wires, l.junctions).length;
  const hvh = (w: LayoutWire) => w.points.length === 4 && Math.abs(w.points[1].x - w.points[2].x) < 0.5
    && Math.abs(w.points[0].y - w.points[1].y) < 0.5 && Math.abs(w.points[2].y - w.points[3].y) < 0.5;
  const crowds = (self: LayoutWire) => {
    for (let s = 0; s < self.points.length - 1; s++) {
      const a = self.points[s], b = self.points[s + 1];
      const horiz = Math.abs(a.y - b.y) < 0.5;
      const perp = horiz ? a.y : a.x, mn = horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y), mx = horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
      for (const o of l.wires) {
        if (o === self || o.fromId === self.fromId) continue;
        for (let k = 0; k < o.points.length - 1; k++) {
          const c = o.points[k], d = o.points[k + 1];
          const oh = Math.abs(c.y - d.y) < 0.5;
          if (oh !== horiz || (!oh && Math.abs(c.x - d.x) >= 0.5) || (oh && Math.abs(c.x - d.x) < 0.5)) continue;
          const dp = Math.abs((oh ? c.y : c.x) - perp);
          if (dp >= MIN_WIRE_SPACING - 0.5) continue;            // clear (dp≈0 exact-overlap counts as crowd)
          const omn = oh ? Math.min(c.x, d.x) : Math.min(c.y, d.y), omx = oh ? Math.max(c.x, d.x) : Math.max(c.y, d.y);
          if (Math.min(mx, omx) - Math.max(mn, omn) > 0.5) return true;
        }
      }
    }
    return false;
  };
  for (const g of l.nodes) {
    if (g.gateType === 'INPUT' || g.gateType === 'OUTPUT' || g.inputs.length < 2 || g.inputs.length > 3) continue;
    const cy = g.absY + g.height / 2;
    const fan = l.wires.filter(w => w.toId === g.id && !w.feedback && hvh(w));
    const above = fan.filter(w => w.points[3].y < cy - 0.5), below = fan.filter(w => w.points[3].y > cy + 0.5);
    if (above.length !== 1 || below.length !== 1) continue;
    const aw = above[0], bw = below[0], ax = aw.points[1].x, bx = bw.points[1].x;
    if (Math.abs(ax - bx) < 0.5) continue;                        // already symmetric
    const targetX = Math.max(ax, bx);                            // align to the channel nearer the gate
    const mover = ax === targetX ? bw : aw;
    const p = mover.points, saved = p.slice();
    if (targetX < p[0].x + 0.5) continue;                        // would backtrack
    if (l.junctions.some(j => (Math.abs(j.x - p[1].x) < 0.5 && Math.abs(j.y - p[1].y) < 0.5)
      || (Math.abs(j.x - p[2].x) < 0.5 && Math.abs(j.y - p[2].y) < 0.5))) continue; // turn carries a fan-out dot
    const before = crossings();
    mover.points = [p[0], { x: targetX, y: p[0].y }, { x: targetX, y: p[3].y }, p[3]];
    if (crossings() > before || crowds(mover)) mover.points = saved; // revert unless strictly clean
  }
}

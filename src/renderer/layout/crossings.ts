import type { LayoutWire, LayoutJunction, WireCrossing } from './types.js';

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

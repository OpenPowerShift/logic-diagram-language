import type { LayoutLabel, LayoutWire, LayoutNode, LayoutJunction, LayoutResult } from './types.js';
import type { RenderOptions } from '../../parser/ast.js';
import { GRID } from './types.js';
import { estimateTextWidth } from '../math-renderer.js';

// Approximate bounding box of a boundary INPUT/OUTPUT node's rendered .Name/.Description text.
// Input labels sit to the LEFT of the port (right-anchored from port.absX - 6); output labels to the
// RIGHT (left-anchored from port.absX + 6). Name is 12px, description 9px stacked below. Net-label
// placement treats these as obstacles so it never lands on a boundary label (issue #21).
function ioLabelBoxes(nodes: LayoutNode[]): { x: number; y: number; w: number; h: number }[] {
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  for (const n of nodes) {
    const isIn = n.gateType === 'INPUT', isOut = n.gateType === 'OUTPUT';
    if (!isIn && !isOut) continue;
    const port = isIn ? n.outputs[0] : n.inputs[0];
    const text = n.name || n.label;
    if (!port || !text) continue;
    const w = Math.max(estimateTextWidth(text, 12), n.description ? estimateTextWidth(n.description, 9) : 0);
    const top = n.description ? port.absY - 18 : port.absY - 9;
    const h = n.description ? 34 : 18;
    const x = isIn ? port.absX - 6 - w : port.absX + 6;
    boxes.push({ x, y: top, w, h });
  }
  return boxes;
}

export function placeNetLabels(labels: LayoutLabel[], wires: LayoutWire[], nodes: LayoutNode[], junctions: LayoutJunction[], opts: RenderOptions): void {
    const ioBoxes = ioLabelBoxes(nodes);
    const boxHitsIOLabel = (x: number, y: number, w: number, h: number): number => {
      let c = 0;
      for (const b of ioBoxes) if (x + w > b.x + 0.5 && b.x + b.w > x + 0.5 && y + h > b.y + 0.5 && b.y + b.h > y + 0.5) c++;
      return c;
    };
    const boxHitsWire = (x: number, y: number, w: number, h: number): number => {
      let c = 0;
      for (const wire of wires) for (let i = 0; i < wire.points.length - 1; i++) {
        const a = wire.points[i], b = wire.points[i + 1];
        if (Math.max(a.x, b.x) > x + 0.5 && Math.min(a.x, b.x) < x + w - 0.5 &&
            Math.max(a.y, b.y) > y + 0.5 && Math.min(a.y, b.y) < y + h - 0.5) c++;
      }
      return c;
    };
    const boxHitsBody = (x: number, y: number, w: number, h: number): number => {
      let c = 0;
      for (const n of nodes) {
        if (n.gateType === 'INPUT' || n.gateType === 'OUTPUT') continue;
        if (x + w > n.absX + 0.5 && n.absX + n.width > x + 0.5 &&
            y + h > n.absY + 0.5 && n.absY + n.height > y + 0.5) c++;
      }
      return c;
    };
    const boxHitsLabel = (x: number, y: number, w: number, h: number, self: LayoutLabel): number => {
      let c = 0;
      for (const o of labels) {
        if (o === self) continue;
        if (x + w > o.x + 0.5 && o.x + o.width > x + 0.5 && y + h > o.y + 0.5 && o.y + o.height > y + 0.5) c++;
      }
      return c;
    };
    // Nearest gap (0 if overlapping) between a label box and an axis-aligned wire segment, treating
    // the segment as its degenerate bounding rect.
    const boxSegDist = (x: number, y: number, w: number, h: number, a: { x: number; y: number }, b: { x: number; y: number }): number => {
      const dx = Math.max(0, Math.max(x - Math.max(a.x, b.x), Math.min(a.x, b.x) - (x + w)));
      const dy = Math.max(0, Math.max(y - Math.max(a.y, b.y), Math.min(a.y, b.y) - (y + h)));
      return Math.hypot(dx, dy);
    };
    for (const lb of labels) {
      if (lb.fixed) continue;                                        // connector tags sit at their stub
      const { width: w, height: h, anchorX: ax, anchorY: ay } = lb;
      // The label NAMES its driver's output net, so it should sit RIGHT NEXT TO that net's wire.
      // Primary objective: clear of wires (the bug) and bodies; among clear spots, MINIMISE the
      // distance to the driver's own fan-out wire so the label hugs the signal it names (rather than
      // floating off to distant whitespace). A tiny bias keeps it above / on the output side only to
      // break ties between equally-close spots.
      // The net's full geometry: EVERY wire driven by this node (all fan-out branches share the
      // driver's id), so placement optimises against the whole net, not one branch. Its fan-out
      // JUNCTION dots (branch points that lie on those wires) are added as point-segments too — a
      // junction is the net's identity node and a natural leader attach point.
      const netWires = wires.filter(wr => wr.fromId === lb.driverId);
      const netSegs: [{ x: number; y: number }, { x: number; y: number }][] = [];
      for (const wr of netWires) for (let i = 0; i < wr.points.length - 1; i++) netSegs.push([wr.points[i], wr.points[i + 1]]);
      const onNet = (jx: number, jy: number) => netSegs.some(([a, b]) =>
        Math.min(a.x, b.x) - 0.5 <= jx && jx <= Math.max(a.x, b.x) + 0.5 &&
        Math.min(a.y, b.y) - 0.5 <= jy && jy <= Math.max(a.y, b.y) + 0.5);
      for (const j of junctions) if (onNet(j.x, j.y)) netSegs.push([{ x: j.x, y: j.y }, { x: j.x, y: j.y }]);
      const distToNet = (x: number, y: number): number => {
        let d = Infinity;
        for (const [a, b] of netSegs) d = Math.min(d, boxSegDist(x, y, w, h, a, b));
        return Number.isFinite(d) ? d : Math.hypot(x - ax, y - ay);
      };
      // The net's MIDPOINT — the point at 50% of the path length of its longest wire. A net label
      // should sit CENTRED on the run it names (beside the middle of the wire), not crammed at the
      // driver or consumer end, so the placement pulls the label toward this midpoint.
      const wireLen = (wr: LayoutWire) => { let t = 0; for (let i = 0; i < wr.points.length - 1; i++) t += Math.hypot(wr.points[i + 1].x - wr.points[i].x, wr.points[i + 1].y - wr.points[i].y); return t; };
      let netMidX = ax, netMidY = ay;
      if (netWires.length) {
        const longest = netWires.reduce((m, wr) => (wireLen(wr) > wireLen(m) ? wr : m));
        const p = longest.points; const half = wireLen(longest) / 2; let acc = 0;
        for (let i = 0; i < p.length - 1; i++) {
          const l = Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
          if (acc + l >= half) { const t = l === 0 ? 0 : (half - acc) / l; netMidX = p[i].x + t * (p[i + 1].x - p[i].x); netMidY = p[i].y + t * (p[i + 1].y - p[i].y); break; }
          acc += l;
        }
      }
      // With a leader line the label sits a readable distance OFF the net (so the connector is visible
      // and the text isn't jammed against the wire); without one it hugs the net (min gap kept clear
      // by boxHitsWire). Among clear spots, minimise distance from the label CENTRE to the net
      // midpoint, so the label centres on the wire's run.
      const idealGap = opts.wireLabelLeader ? 16 : 0;
      const cost = (x: number, y: number) => {
        const dn = distToNet(x, y);
        const gapPenalty = dn < idealGap - 0.5 ? (idealGap - dn) * 500 : 0;   // keep >= gap off the wire
        const toMid = Math.hypot(x + w / 2 - netMidX, y + h / 2 - netMidY);   // pull to the run's centre
        const tieBias = (x + w < ax - 0.5 ? 4 : 0) + (y > ay + 0.5 ? 2 : 0);  // gentle above/output-side lean for ties
        return boxHitsWire(x, y, w, h) * 100000 + boxHitsBody(x, y, w, h) * 3000 + boxHitsLabel(x, y, w, h, lb) * 2000 +
          boxHitsIOLabel(x, y, w, h) * 2000 + gapPenalty + toMid + tieBias;
      };
      let best = { x: lb.x, y: lb.y, c: cost(lb.x, lb.y) };
      const defaultClean = boxHitsWire(lb.x, lb.y, w, h) === 0 && boxHitsBody(lb.x, lb.y, w, h) === 0 && boxHitsIOLabel(lb.x, lb.y, w, h) === 0;
      // Relocate when the default overlaps, OR always under WIRE_LABEL_LEADER (to seat every label at
      // the readable gap its connector needs). Search a window centred on the net MIDPOINT so the
      // label can reach the middle of the run even when the driver output is far away.
      if (!defaultClean || opts.wireLabelLeader) {
        for (let x = Math.round((netMidX - w - 60) / GRID) * GRID; x <= netMidX + 60; x += GRID) {
          for (let y = Math.round((netMidY - 120) / GRID) * GRID; y <= netMidY + 120; y += GRID) {
            if (x < 0 || y < 0) continue;
            const c = cost(x, y);
            if (c < best.c) best = { x, y, c };
          }
        }
        lb.x = best.x; lb.y = best.y;
      }
      // Leader target (leaderX/leaderY) is assigned LAST, in layoutDiagram, on the FINAL geometry —
      // see assignLeaderTargets. Computing it here would miss later reshaping (symmetriseSmallGates
      // moves small gates' fan-in channels AFTER layoutOnce returns), orphaning the leader.
    }
  }

export function assignLeaderTargets(result: LayoutResult): void {
  // A leader must land on a VISIBLE part of the wire, not inside a gate/block body: the net's end
  // point is the consumer's input port, which sits inside that gate's box (an OR input taps the
  // concave curve), so attaching there makes the leader point at the gate. Exclude body-covered
  // points and take the nearest CLEAR net point; fall back to the raw nearest only if the whole net
  // is body-covered (a fully-adjacent driver→consumer with no clear run).
  const bodies = result.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
  const inBody = (px: number, py: number) => bodies.some(g =>
    px > g.absX - 1 && px < g.absX + g.width + 1 && py > g.absY - 1 && py < g.absY + g.height + 1);
  for (const lb of result.labels) {
    const segs: [{ x: number; y: number }, { x: number; y: number }][] = [];
    for (const w of result.wires) {
      if (w.fromId !== lb.driverId) continue;
      for (let i = 0; i < w.points.length - 1; i++) segs.push([w.points[i], w.points[i + 1]]);
    }
    const onNet = (jx: number, jy: number) => segs.some(([a, b]) =>
      Math.min(a.x, b.x) - 0.5 <= jx && jx <= Math.max(a.x, b.x) + 0.5 &&
      Math.min(a.y, b.y) - 0.5 <= jy && jy <= Math.max(a.y, b.y) + 0.5);
    for (const j of result.junctions) if (onNet(j.x, j.y)) segs.push([{ x: j.x, y: j.y }, { x: j.x, y: j.y }]);
    const cx = lb.x + lb.width / 2, cy = lb.y + lb.height / 2;
    let bd = Infinity, fbBd = Infinity, fbX: number | undefined, fbY: number | undefined;
    lb.leaderX = undefined; lb.leaderY = undefined;
    // Sample each net segment at grid resolution; keep the nearest clear point (and, separately, the
    // nearest point of any kind as a fallback).
    for (const [a, b] of segs) {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(len / GRID));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const px = a.x + t * dx, py = a.y + t * dy;
        const d = Math.hypot(px - cx, py - cy);
        if (d < fbBd) { fbBd = d; fbX = px; fbY = py; }
        if (inBody(px, py)) continue;
        if (d < bd) { bd = d; lb.leaderX = px; lb.leaderY = py; }
      }
    }
    if (lb.leaderX === undefined) { lb.leaderX = fbX; lb.leaderY = fbY; }
  }
}

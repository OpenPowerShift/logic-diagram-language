const CELL_SIZE = 5;
const BLOCKED_COST = 1e7;
const WIRE_CROSS_COST = 8;
const WIRE_PROXIMITY_COST = 3; // soft cost up to PROXIMITY_RADIUS cells from other-source wires
const PROXIMITY_RADIUS = 2;    // spread parallel wires into separate tracks (~10px apart)
const SAME_SOURCE_BONUS = -8; // makes overlapping a same-source trunk free, so fan-out shares one trunk
const WRONG_SIDE_COST = 30;
const BEND_PENALTY = 4;        // tuned so the optimum is a straight line or a single clean Z
const GATE_BUFFER_RATIO = 0.2;
const GATE_BUFFER_MIN = 10; // absolute min horizontal clearance (px) wires keep from a gate body
// Larger vertical clearance: a horizontal wire passing above/below a gate stays >= 2x the
// wire gap off its top/bottom edge, so it never looks visually crammed against the body.
const GATE_BUFFER_MIN_Y = 20;

export interface Vec2 {
  x: number;
  y: number;
}

export interface GateObstacle {
  x: number;
  y: number;
  w: number;
  h: number;
  id: string;
}

export interface RoutedSegment {
  points: Vec2[];
  fromId: string;
}

class MinHeap<T extends { f: number }> {
  private data: T[] = [];

  push(item: T) {
    this.data.push(item);
    this._bubbleUp(this.data.length - 1);
  }

  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  get size() {
    return this.data.length;
  }

  private _bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[parent].f <= this.data[i].f) break;
      [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
      i = parent;
    }
  }

  private _sinkDown(i: number) {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.data[left].f < this.data[smallest].f) smallest = left;
      if (right < n && this.data[right].f < this.data[smallest].f) smallest = right;
      if (smallest === i) break;
      [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
      i = smallest;
    }
  }
}

const DIRS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

function toGrid(v: number): number {
  return Math.round(v / CELL_SIZE);
}

function toCanvas(v: number): number {
  return v * CELL_SIZE;
}

function rasterizeRect(
  grid: Float32Array, gridW: number, gridH: number,
  x: number, y: number, w: number, h: number,
  cost: number, bufferX: number, bufferY: number,
  ox = 0, oy = 0,
) {
  const x0 = Math.max(0, toGrid(x - bufferX) - ox);
  const y0 = Math.max(0, toGrid(y - bufferY) - oy);
  const x1 = Math.min(gridW - 1, toGrid(x + w + bufferX) - ox);
  const y1 = Math.min(gridH - 1, toGrid(y + h + bufferY) - oy);
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const idx = gy * gridW + gx;
      if (cost > grid[idx]) grid[idx] = cost;
    }
  }
}

function setCellCost(grid: Float32Array, gridW: number, gridH: number, gx: number, gy: number, cost: number) {
  if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) {
    const idx = gy * gridW + gx;
    if (cost > grid[idx] && grid[idx] < BLOCKED_COST) grid[idx] = cost;
  }
}

function rasterizeWireSegments(
  grid: Float32Array, gridW: number, gridH: number,
  segments: RoutedSegment[],
  sameSourceFromId?: string,
  ox = 0, oy = 0,
) {
  for (const seg of segments) {
    const isSameSource = sameSourceFromId !== undefined && seg.fromId === sameSourceFromId;
    const crossCost = isSameSource ? Math.max(0, WIRE_CROSS_COST + SAME_SOURCE_BONUS) : WIRE_CROSS_COST;
    const proxityCost = isSameSource ? 0 : WIRE_PROXIMITY_COST;
    const pts = seg.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      if (Math.abs(p0.y - p1.y) < 1) {
        const y = toGrid(p0.y) - oy;
        const gx0 = toGrid(Math.min(p0.x, p1.x)) - ox;
        const gx1 = toGrid(Math.max(p0.x, p1.x)) - ox;
        for (let gx = gx0; gx <= gx1; gx++) {
          setCellCost(grid, gridW, gridH, gx, y, crossCost);
          for (let r = 1; r <= PROXIMITY_RADIUS && proxityCost > 0; r++) {
            setCellCost(grid, gridW, gridH, gx, y - r, proxityCost);
            setCellCost(grid, gridW, gridH, gx, y + r, proxityCost);
          }
        }
      } else if (Math.abs(p0.x - p1.x) < 1) {
        const x = toGrid(p0.x) - ox;
        const gy0 = toGrid(Math.min(p0.y, p1.y)) - oy;
        const gy1 = toGrid(Math.max(p0.y, p1.y)) - oy;
        for (let gy = gy0; gy <= gy1; gy++) {
          setCellCost(grid, gridW, gridH, x, gy, crossCost);
          for (let r = 1; r <= PROXIMITY_RADIUS && proxityCost > 0; r++) {
            setCellCost(grid, gridW, gridH, x - r, gy, proxityCost);
            setCellCost(grid, gridW, gridH, x + r, gy, proxityCost);
          }
        }
      }
    }
  }
}

function rasterizeWrongSideZone(
  grid: Float32Array, gridW: number, gridH: number,
  gateX: number, gateY: number, gateW: number, gateH: number, portX: number,
  ox = 0, oy = 0,
) {
  const x0 = Math.max(0, toGrid(portX) - ox);
  const x1 = Math.min(gridW - 1, toGrid(gateX + gateW) - ox);
  const y0 = Math.max(0, toGrid(gateY) - oy);
  const y1 = Math.min(gridH - 1, toGrid(gateY + gateH) - oy);
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const idx = gy * gridW + gx;
      if (WRONG_SIDE_COST > grid[idx]) grid[idx] = WRONG_SIDE_COST;
    }
  }
}

function simplifyPath(path: Vec2[]): Vec2[] {
  if (path.length <= 2) return path;
  const result: Vec2[] = [path[0]];
  let prevDx = path[1].x - path[0].x;
  let prevDy = path[1].y - path[0].y;
  for (let i = 1; i < path.length - 1; i++) {
    const dx = path[i + 1].x - path[i].x;
    const dy = path[i + 1].y - path[i].y;
    if (dx !== prevDx || dy !== prevDy) {
      result.push(path[i]);
      prevDx = dx;
      prevDy = dy;
    }
  }
  result.push(path[path.length - 1]);
  return result;
}

// A straight horizontal wire is allowed unless it actually passes through a gate
// BODY (plus a small margin). The 20% routing buffer is intentionally NOT used here:
// a wire running clear of a gate should stay straight rather than be forced into A*.
function lineHitsObstacle(
  y: number, x1: number, x2: number,
  obstacles: GateObstacle[],
  sourceGateX: number, sourceGateY: number,
  destGateX: number, destGateY: number,
): boolean {
  const xMin = Math.min(x1, x2);
  const xMax = Math.max(x1, x2);
  const m = 3;                    // horizontal margin (just clear the gate's left/right edge)
  const my = GATE_BUFFER_MIN_Y;   // vertical clearance (keep off the gate's top/bottom edge)
  for (const obs of obstacles) {
    if (obs.x === sourceGateX && obs.y === sourceGateY) continue;
    if (obs.x === destGateX && obs.y === destGateY) continue;
    // An obstacle entirely left of the wire's start (or right of its end) cannot lie on this
    // rightward horizontal run — skip it before applying the margin, so a same-column input
    // (whose right edge meets the wire's start X) never falsely blocks its neighbour's wire.
    if (obs.x + obs.w <= xMin + 0.5 || obs.x >= xMax - 0.5) continue;
    if (rectsOverlap(xMin, y - 1, xMax - xMin, 2,
                     obs.x - m, obs.y - my, obs.w + m * 2, obs.h + my * 2, 0)) {
      return true;
    }
  }
  return false;
}

function rectsOverlap(
  x1: number, y1: number, w1: number, h1: number,
  x2: number, y2: number, w2: number, h2: number, pad: number,
): boolean {
  return x1 + w1 + pad > x2 && x2 + w2 + pad > x1 &&
         y1 + h1 + pad > y2 && y2 + h2 + pad > y1;
}

// True if the axis-aligned segment passes through any gate body (plus the routing buffer),
// excluding the wire's own source and destination gates.
function segHitsObstacle(
  ax: number, ay: number, bx: number, by: number,
  obstacles: GateObstacle[], sgx: number, sgy: number, dgx: number, dgy: number,
): boolean {
  const xMin = Math.min(ax, bx), yMin = Math.min(ay, by);
  const w = Math.abs(bx - ax) + 1, h = Math.abs(by - ay) + 1;
  for (const o of obstacles) {
    if (o.x === sgx && o.y === sgy) continue;
    if (o.x === dgx && o.y === dgy) continue;
    const bufX = Math.max(GATE_BUFFER_MIN, Math.ceil(o.w * GATE_BUFFER_RATIO));
    const bufY = Math.max(GATE_BUFFER_MIN_Y, Math.ceil(o.h * GATE_BUFFER_RATIO));
    if (rectsOverlap(xMin - 0.5, yMin - 0.5, w, h, o.x - bufX, o.y - bufY, o.w + 2 * bufX, o.h + 2 * bufY, 0)) return true;
  }
  return false;
}

// True if the axis-aligned segment crosses (or runs along) a routed wire from a different
// source. Same-source overlaps are allowed (shared trunks).
function segCrossesWire(
  ax: number, ay: number, bx: number, by: number,
  routed: RoutedSegment[], fromId?: string,
): boolean {
  const horiz = Math.abs(ay - by) < 0.5;
  const axMin = Math.min(ax, bx), axMax = Math.max(ax, bx);
  const ayMin = Math.min(ay, by), ayMax = Math.max(ay, by);
  for (const s of routed) {
    if (fromId !== undefined && s.fromId === fromId) continue;
    for (let i = 0; i < s.points.length - 1; i++) {
      const p = s.points[i], q = s.points[i + 1];
      const sHoriz = Math.abs(p.y - q.y) < 0.5, sVert = Math.abs(p.x - q.x) < 0.5;
      const sxMin = Math.min(p.x, q.x), sxMax = Math.max(p.x, q.x);
      const syMin = Math.min(p.y, q.y), syMax = Math.max(p.y, q.y);
      if (horiz && sVert) {
        if (p.x >= axMin - 0.5 && p.x <= axMax + 0.5 && ay >= syMin - 0.5 && ay <= syMax + 0.5) return true;
      } else if (!horiz && sHoriz) {
        if (ax >= sxMin - 0.5 && ax <= sxMax + 0.5 && p.y >= ayMin - 0.5 && p.y <= ayMax + 0.5) return true;
      } else if (horiz && sHoriz && Math.abs(ay - p.y) < 0.5) {
        if (axMax > sxMin + 0.5 && axMin < sxMax - 0.5) return true;
      } else if (!horiz && sVert && Math.abs(ax - p.x) < 0.5) {
        if (ayMax > syMin + 0.5 && ayMin < syMax - 0.5) return true;
      }
    }
  }
  return false;
}

// True if a channel vertical at `cx` (spanning vy0..vy1) would run within `minGap` of another
// net's vertical that overlaps it in Y — i.e. they'd read as one cramped bundle. Used so the
// clean-Z fast path spreads parallel verticals into separate tracks (matching A*'s proximity
// cost, which the fast path would otherwise bypass).
function verticalTooClose(
  cx: number, vy0: number, vy1: number, routed: RoutedSegment[], fromId: string | undefined, minGap: number,
): boolean {
  const vyMin = Math.min(vy0, vy1), vyMax = Math.max(vy0, vy1);
  for (const s of routed) {
    if (fromId !== undefined && s.fromId === fromId) continue;
    for (let i = 0; i < s.points.length - 1; i++) {
      const p = s.points[i], q = s.points[i + 1];
      if (Math.abs(p.x - q.x) < 0.5 && Math.abs(p.x - cx) > 0.5 && Math.abs(p.x - cx) < minGap &&
          Math.max(p.y, q.y) > vyMin - 0.5 && Math.min(p.y, q.y) < vyMax + 0.5) return true;
    }
  }
  return false;
}

// Try to connect source→dest with a clean Z (horizontal, vertical channel, horizontal)
// without a grid search: cheap, and the common case. Returns null if no clear channel is
// found (then the caller falls back to A*). The balanced-Z pass later re-centres the channel.
function tryCleanZ(
  sx: number, sy: number, dx: number, dy: number,
  obstacles: GateObstacle[], sgx: number, sgy: number, dgx: number, dgy: number,
  routed: RoutedSegment[], fromId?: string,
): Vec2[] | null {
  if (dx <= sx + 2 * CELL_SIZE) return null; // need forward room; let A* handle the rest
  const mid = Math.round((sx + dx) / 2 / CELL_SIZE) * CELL_SIZE;
  // Search the whole span between source and dest (ordered from the midpoint outward), not
  // just a narrow band. When many wires fan into one gate they each need a *distinct* clean
  // channel; a wide search finds one per wire and avoids an expensive grid search each.
  const cands = [mid];
  const maxOff = Math.max(6 * CELL_SIZE, dx - sx);
  for (let off = CELL_SIZE; off <= maxOff; off += CELL_SIZE) { cands.push(mid + off); cands.push(mid - off); }
  // Two passes: first prefer a channel that also keeps clear of other nets' parallel
  // verticals (so wires spread into separate, readable tracks); if none exists, accept any
  // obstacle- and crossing-free channel rather than fall back to an expensive grid search.
  const SPREAD = 3 * CELL_SIZE;
  for (const requireSpread of [true, false]) {
    for (const cx of cands) {
      if (cx <= sx + CELL_SIZE || cx >= dx) continue;
      if (segHitsObstacle(sx, sy, cx, sy, obstacles, sgx, sgy, dgx, dgy)) continue;
      if (segHitsObstacle(cx, sy, cx, dy, obstacles, sgx, sgy, dgx, dgy)) continue;
      if (segHitsObstacle(cx, dy, dx, dy, obstacles, sgx, sgy, dgx, dgy)) continue;
      if (segCrossesWire(sx, sy, cx, sy, routed, fromId)) continue;
      if (segCrossesWire(cx, sy, cx, dy, routed, fromId)) continue;
      if (segCrossesWire(cx, dy, dx, dy, routed, fromId)) continue;
      if (requireSpread && verticalTooClose(cx, sy, dy, routed, fromId, SPREAD)) continue;
      return [{ x: sx, y: sy }, { x: cx, y: sy }, { x: cx, y: dy }, { x: dx, y: dy }];
    }
  }
  return null;
}

// Drop duplicate and colinear vertices so the path is a minimal list of corners.
function cleanColinear(pts: Vec2[]): Vec2[] {
  if (pts.length <= 2) return pts;
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    const prev = out[out.length - 1];
    if (Math.abs(cur.x - prev.x) < 1 && Math.abs(cur.y - prev.y) < 1) continue; // duplicate
    if (out.length >= 2) {
      const p2 = out[out.length - 2];
      const colinH = Math.abs(p2.y - prev.y) < 1 && Math.abs(prev.y - cur.y) < 1;
      const colinV = Math.abs(p2.x - prev.x) < 1 && Math.abs(prev.x - cur.x) < 1;
      if (colinH || colinV) { out[out.length - 1] = cur; continue; }
    }
    out.push(cur);
  }
  return out;
}

/**
 * Convert a grid-aligned A* corner path to canvas coordinates with EXACT port
 * endpoints, guaranteeing every segment is horizontal or vertical and that the
 * path always begins at the source and ends at the destination.
 *
 * Interior corners come straight from the grid path (already on the 5px grid).
 * The exact endpoints replace the first/last grid points; if that leaves a
 * diagonal segment at an endpoint we insert a single orthogonal corner. The last
 * segment is made horizontal so wires enter their destination port from the side.
 */
// Orthogonal fallback between two points when no routed path is available: a straight line if
// they share a Y, otherwise a clean Z (exit and enter horizontally). NEVER a diagonal — an
// orthogonal route that may clip an obstacle is always preferable to a non-orthogonal segment.
// When obstacles are supplied, the Z's bend X is chosen (searching from the midpoint outward) so
// the three segments clear all gate bodies where possible — only clipping as an absolute last resort.
function orthFallback(
  sourceX: number, sourceY: number, destX: number, destY: number,
  obstacles?: GateObstacle[], sgx = 0, sgy = 0, dgx = 0, dgy = 0,
): Vec2[] {
  if (Math.abs(sourceY - destY) < 1) return [{ x: sourceX, y: sourceY }, { x: destX, y: destY }];
  const z = (mx: number): Vec2[] => [
    { x: sourceX, y: sourceY }, { x: mx, y: sourceY }, { x: mx, y: destY }, { x: destX, y: destY },
  ];
  const mid = Math.round((sourceX + destX) / 2 / CELL_SIZE) * CELL_SIZE;
  if (obstacles) {
    const lo = Math.min(sourceX, destX), hi = Math.max(sourceX, destX);
    const cands = [mid];
    for (let off = CELL_SIZE; off <= Math.abs(destX - sourceX); off += CELL_SIZE) { cands.push(mid + off); cands.push(mid - off); }
    for (const mx of cands) {
      if (mx <= lo + CELL_SIZE || mx >= hi) continue;
      if (segHitsObstacle(sourceX, sourceY, mx, sourceY, obstacles, sgx, sgy, dgx, dgy)) continue;
      if (segHitsObstacle(mx, sourceY, mx, destY, obstacles, sgx, sgy, dgx, dgy)) continue;
      if (segHitsObstacle(mx, destY, destX, destY, obstacles, sgx, sgy, dgx, dgy)) continue;
      return z(mx);
    }
  }
  return z(mid);
}

function orthogonalize(
  gridPath: Vec2[],
  sourceX: number, sourceY: number,
  destX: number, destY: number,
): Vec2[] {
  if (gridPath.length <= 1) {
    return orthFallback(sourceX, sourceY, destX, destY);
  }

  const pts: Vec2[] = gridPath.map(p => ({ x: toCanvas(p.x), y: toCanvas(p.y) }));
  pts[0] = { x: sourceX, y: sourceY };
  pts[pts.length - 1] = { x: destX, y: destY };

  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    const cur = pts[i];
    const diagX = Math.abs(cur.x - prev.x) >= 1;
    const diagY = Math.abs(cur.y - prev.y) >= 1;
    if (diagX && diagY) {
      // Insert one corner to keep the segment orthogonal. For the final segment,
      // corner vertically first so the wire enters the dest port horizontally;
      // otherwise corner horizontally first (exit/travel along rows).
      if (i === pts.length - 1) out.push({ x: prev.x, y: cur.y });
      else out.push({ x: cur.x, y: prev.y });
    }
    out.push(cur);
  }

  return cleanColinear(out);
}

export function routeWireAStar(
  sourceX: number, sourceY: number,
  destX: number, destY: number,
  obstacles: GateObstacle[],
  sourceGateX: number, sourceGateY: number,
  sourceGateW: number, sourceGateH: number,
  destGateX: number, destGateY: number,
  destGateW: number, destGateH: number,
  destIsGate: boolean,
  routedSegments: RoutedSegment[],
  canvasW: number, canvasH: number,
  sameSourceFromId?: string,
): Vec2[] {
  // Fast path: straight line when Y is same and no obstacle blocks
  if (Math.abs(sourceY - destY) < 1) {
    if (!lineHitsObstacle(sourceY, sourceX, destX, obstacles,
                          sourceGateX, sourceGateY, destGateX, destGateY)) {
      return [{ x: sourceX, y: sourceY }, { x: destX, y: destY }];
    }
  }

  // Fast path: a clean Z-route avoiding gate bodies and other nets. Skips the grid search
  // for the common case (no obstacle between source and destination), which keeps layout
  // time low on large diagrams. A* is only used when no clear channel exists.
  const zPath = tryCleanZ(sourceX, sourceY, destX, destY, obstacles,
                          sourceGateX, sourceGateY, destGateX, destGateY,
                          routedSegments, sameSourceFromId);
  if (zPath) return zPath;

  // Grid A* over a region [oGX,oGY] (grid-cell origin) of size gW x gH cells. Returns the
  // routed path, or null if the goal is unreachable within the region. Reconstructed points
  // are in GLOBAL grid coordinates so orthogonalize() maps them straight to canvas pixels.
  const NODE_FIELDS = 5;
  const solve = (oGX: number, oGY: number, gW: number, gH: number): Vec2[] | null => {
    const startX = toGrid(sourceX) - oGX, startY = toGrid(sourceY) - oGY;
    const goalX = toGrid(destX) - oGX, goalY = toGrid(destY) - oGY;
    if (startX < 0 || startX >= gW || startY < 0 || startY >= gH) return null;
    if (goalX < 0 || goalX >= gW || goalY < 0 || goalY >= gH) return null;

    const gridSize = gW * gH;
    const grid = new Float32Array(gridSize);
    grid.fill(1);

    for (const obs of obstacles) {
      const isSource = obs.x === sourceGateX && obs.y === sourceGateY;
      const isDest = obs.x === destGateX && obs.y === destGateY;
      const bufferX = Math.max(GATE_BUFFER_MIN, Math.ceil(obs.w * GATE_BUFFER_RATIO));
      const bufferY = Math.max(GATE_BUFFER_MIN_Y, Math.ceil(obs.h * GATE_BUFFER_RATIO));
      if (isSource || isDest) rasterizeRect(grid, gW, gH, obs.x, obs.y, obs.w, obs.h, BLOCKED_COST, 0, 0, oGX, oGY);
      else rasterizeRect(grid, gW, gH, obs.x, obs.y, obs.w, obs.h, BLOCKED_COST, bufferX, bufferY, oGX, oGY);
    }
    rasterizeWireSegments(grid, gW, gH, routedSegments, sameSourceFromId, oGX, oGY);
    if (destIsGate) rasterizeWrongSideZone(grid, gW, gH, destGateX, destGateY, destGateW, destGateH, destX, oGX, oGY);

    // Clear corridors at the ports and around start/goal so A* can always exit/enter.
    for (let gx = startX; gx <= toGrid(sourceGateX + sourceGateW + 5) - oGX; gx++) {
      if (gx >= 0 && gx < gW && startY >= 0 && startY < gH) grid[startY * gW + gx] = 1;
    }
    for (let gx = Math.max(0, toGrid(destGateX - 5) - oGX); gx <= goalX; gx++) {
      if (gx >= 0 && gx < gW && goalY >= 0 && goalY < gH) grid[goalY * gW + gx] = 1;
    }
    for (const [px, py] of [[startX - 1, startY], [startX + 1, startY], [startX, startY - 1], [startX, startY + 1], [goalX - 1, goalY], [goalX + 1, goalY], [goalX, goalY - 1], [goalX, goalY + 1]]) {
      if (px >= 0 && px < gW && py >= 0 && py < gH) grid[py * gW + px] = 1;
    }
    grid[startY * gW + startX] = 1;
    grid[goalY * gW + goalX] = 1;

    const nodes = new Float64Array(gridSize * NODE_FIELDS);
    const closedFlags = new Uint8Array(gridSize);
    for (let i = 0; i < gridSize; i++) nodes[i * NODE_FIELDS] = Infinity;

    const startIdx = startY * gW + startX;
    nodes[startIdx * NODE_FIELDS] = 0;
    nodes[startIdx * NODE_FIELDS + 1] = Math.abs(goalX - startX) + Math.abs(goalY - startY);
    nodes[startIdx * NODE_FIELDS + 4] = -1;

    const openHeap = new MinHeap<{ f: number; x: number; y: number }>();
    openHeap.push({ f: Math.abs(goalX - startX) + Math.abs(goalY - startY), x: startX, y: startY });

    while (openHeap.size > 0) {
      const current = openHeap.pop()!;
      const cx = current.x, cy = current.y;
      const cIdx = cy * gW + cx;
      if (closedFlags[cIdx]) continue;
      closedFlags[cIdx] = 1;
      if (cx === goalX && cy === goalY) break;

      const currentG = nodes[cIdx * NODE_FIELDS];
      const currentDir = nodes[cIdx * NODE_FIELDS + 4];

      for (let d = 0; d < 4; d++) {
        const nx = cx + DIRS[d].dx;
        const ny = cy + DIRS[d].dy;
        if (nx < 0 || nx >= gW || ny < 0 || ny >= gH) continue;
        const nIdx = ny * gW + nx;
        if (closedFlags[nIdx]) continue;
        const cellCost = grid[nIdx];
        if (cellCost >= BLOCKED_COST) continue;
        let moveCost = 1 + cellCost;
        if (currentDir >= 0 && currentDir !== d) moveCost += BEND_PENALTY;
        const newG = currentG + moveCost;
        const nGOffset = nIdx * NODE_FIELDS;
        if (newG < nodes[nGOffset]) {
          nodes[nGOffset] = newG;
          nodes[nIdx * NODE_FIELDS + 1] = newG + Math.abs(goalX - nx) + Math.abs(goalY - ny);
          nodes[nIdx * NODE_FIELDS + 2] = cx;
          nodes[nIdx * NODE_FIELDS + 3] = cy;
          nodes[nIdx * NODE_FIELDS + 4] = d;
          openHeap.push({ f: nodes[nIdx * NODE_FIELDS + 1], x: nx, y: ny });
        }
      }
    }

    const goalIdx = goalY * gW + goalX;
    if (nodes[goalIdx * NODE_FIELDS] === Infinity) return null;

    const gridPath: Vec2[] = [];
    let cx = goalX, cy = goalY;
    while (cx !== startX || cy !== startY) {
      gridPath.push({ x: cx + oGX, y: cy + oGY });
      const idx = cy * gW + cx;
      cx = nodes[idx * NODE_FIELDS + 2];
      cy = nodes[idx * NODE_FIELDS + 3];
    }
    gridPath.push({ x: startX + oGX, y: startY + oGY });
    gridPath.reverse();
    return orthogonalize(simplifyPath(gridPath), sourceX, sourceY, destX, destY);
  };

  // Try a region bounded to the source/dest bounding box (plus margin for detours) first —
  // this keeps grid allocation and search proportional to the wire, not the whole canvas.
  // Fall back to the full canvas if no path is found in the bounded region.
  const fullGW = Math.ceil(canvasW / CELL_SIZE);
  const fullGH = Math.ceil(canvasH / CELL_SIZE);
  const margin = 160;
  const minXpx = Math.max(0, Math.min(sourceX, destX, sourceGateX, destGateX) - margin);
  const maxXpx = Math.min(canvasW, Math.max(sourceX, destX, sourceGateX + sourceGateW, destGateX + destGateW) + margin);
  const minYpx = Math.max(0, Math.min(sourceY, destY, sourceGateY, destGateY) - margin);
  const maxYpx = Math.min(canvasH, Math.max(sourceY, destY, sourceGateY + sourceGateH, destGateY + destGateH) + margin);
  const oGX = toGrid(minXpx), oGY = toGrid(minYpx);
  const bGW = Math.min(fullGW, toGrid(maxXpx) - oGX + 1);
  const bGH = Math.min(fullGH, toGrid(maxYpx) - oGY + 1);

  return solve(oGX, oGY, bGW, bGH)
    ?? solve(0, 0, fullGW, fullGH)
    ?? orthFallback(sourceX, sourceY, destX, destY, obstacles, sourceGateX, sourceGateY, destGateX, destGateY); // orthogonal, gate-clear, never a diagonal
}
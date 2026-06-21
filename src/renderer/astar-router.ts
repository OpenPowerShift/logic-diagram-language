const CELL_SIZE = 5;
const BLOCKED_COST = 1e7;
const WIRE_CROSS_COST = 8;
const WIRE_PROXIMITY_COST = 3; // soft cost up to PROXIMITY_RADIUS cells from other-source wires
const PROXIMITY_RADIUS = 2;    // spread parallel wires into separate tracks (~10px apart)
const SAME_SOURCE_BONUS = -8; // makes overlapping a same-source trunk free, so fan-out shares one trunk
const WRONG_SIDE_COST = 30;
const BEND_PENALTY = 4;        // tuned so the optimum is a straight line or a single clean Z
const GATE_BUFFER_RATIO = 0.2;
const GATE_BUFFER_MIN = 10; // absolute min clearance (px) wires keep from a gate body

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
) {
  const x0 = Math.max(0, toGrid(x - bufferX));
  const y0 = Math.max(0, toGrid(y - bufferY));
  const x1 = Math.min(gridW - 1, toGrid(x + w + bufferX));
  const y1 = Math.min(gridH - 1, toGrid(y + h + bufferY));
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
) {
  for (const seg of segments) {
    const isSameSource = sameSourceFromId !== undefined && seg.fromId === sameSourceFromId;
    const crossCost = isSameSource ? Math.max(0, WIRE_CROSS_COST + SAME_SOURCE_BONUS) : WIRE_CROSS_COST;
    const proxityCost = isSameSource ? 0 : WIRE_PROXIMITY_COST;
    const pts = seg.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      if (Math.abs(p0.y - p1.y) < 1) {
        const y = toGrid(p0.y);
        const gx0 = toGrid(Math.min(p0.x, p1.x));
        const gx1 = toGrid(Math.max(p0.x, p1.x));
        for (let gx = gx0; gx <= gx1; gx++) {
          setCellCost(grid, gridW, gridH, gx, y, crossCost);
          for (let r = 1; r <= PROXIMITY_RADIUS && proxityCost > 0; r++) {
            setCellCost(grid, gridW, gridH, gx, y - r, proxityCost);
            setCellCost(grid, gridW, gridH, gx, y + r, proxityCost);
          }
        }
      } else if (Math.abs(p0.x - p1.x) < 1) {
        const x = toGrid(p0.x);
        const gy0 = toGrid(Math.min(p0.y, p1.y));
        const gy1 = toGrid(Math.max(p0.y, p1.y));
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
) {
  const x0 = Math.max(0, toGrid(portX));
  const x1 = Math.min(gridW - 1, toGrid(gateX + gateW));
  const y0 = Math.max(0, toGrid(gateY));
  const y1 = Math.min(gridH - 1, toGrid(gateY + gateH));
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
  const m = 3;
  for (const obs of obstacles) {
    if (obs.x === sourceGateX && obs.y === sourceGateY) continue;
    if (obs.x === destGateX && obs.y === destGateY) continue;
    if (rectsOverlap(xMin, y - 1, xMax - xMin, 2,
                     obs.x - m, obs.y - m, obs.w + m * 2, obs.h + m * 2, 0)) {
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
function orthogonalize(
  gridPath: Vec2[],
  sourceX: number, sourceY: number,
  destX: number, destY: number,
): Vec2[] {
  if (gridPath.length <= 1) {
    return [{ x: sourceX, y: sourceY }, { x: destX, y: destY }];
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

  const gridW = Math.ceil(canvasW / CELL_SIZE);
  const gridH = Math.ceil(canvasH / CELL_SIZE);
  const gridSize = gridW * gridH;

  const grid = new Float32Array(gridSize);
  grid.fill(1);

  for (const obs of obstacles) {
    const isSource = obs.x === sourceGateX && obs.y === sourceGateY;
    const isDest = obs.x === destGateX && obs.y === destGateY;
    const bufferX = Math.max(GATE_BUFFER_MIN, Math.ceil(obs.w * GATE_BUFFER_RATIO));
    const bufferY = Math.max(GATE_BUFFER_MIN, Math.ceil(obs.h * GATE_BUFFER_RATIO));
    if (isSource || isDest) {
      rasterizeRect(grid, gridW, gridH, obs.x, obs.y, obs.w, obs.h, BLOCKED_COST, 0, 0);
    } else {
      rasterizeRect(grid, gridW, gridH, obs.x, obs.y, obs.w, obs.h, BLOCKED_COST, bufferX, bufferY);
    }
  }

  rasterizeWireSegments(grid, gridW, gridH, routedSegments, sameSourceFromId);

  if (destIsGate) {
    rasterizeWrongSideZone(grid, gridW, gridH, destGateX, destGateY, destGateW, destGateH, destX);
  }

  const startX = toGrid(sourceX);
  const startY = toGrid(sourceY);
  const goalX = toGrid(destX);
  const goalY = toGrid(destY);

  // Clear a corridor from source port to outside the source gate
  // The source port is typically on the right edge of the gate
  for (let gx = startX; gx <= toGrid(sourceGateX + sourceGateW + 5); gx++) {
    if (gx >= 0 && gx < gridW && startY >= 0 && startY < gridH) {
      grid[startY * gridW + gx] = 1;
    }
  }
  // Clear a corridor from destination port to the left edge of the dest gate
  // The destination port is typically on/near the left edge of the gate
  for (let gx = Math.max(0, toGrid(destGateX - 5)); gx <= goalX; gx++) {
    if (gx >= 0 && gx < gridW && goalY >= 0 && goalY < gridH) {
      grid[goalY * gridW + gx] = 1;
    }
  }
  // Also clear cells immediately around start and goal so A* can expand
  for (const [cx, cy] of [[startX - 1, startY], [startX + 1, startY], [startX, startY - 1], [startX, startY + 1]]) {
    if (cx >= 0 && cx < gridW && cy >= 0 && cy < gridH) grid[cy * gridW + cx] = 1;
  }
  for (const [cx, cy] of [[goalX - 1, goalY], [goalX + 1, goalY], [goalX, goalY - 1], [goalX, goalY + 1]]) {
    if (cx >= 0 && cx < gridW && cy >= 0 && cy < gridH) grid[cy * gridW + cx] = 1;
  }

  // Clear start and goal cells
  grid[startY * gridW + startX] = 1;
  grid[goalY * gridW + goalX] = 1;

  const NODE_FIELDS = 5;
  const nodes = new Float64Array(gridSize * NODE_FIELDS);
  const closedFlags = new Uint8Array(gridSize);

  for (let i = 0; i < gridSize; i++) {
    nodes[i * NODE_FIELDS] = Infinity; // g
  }

  const startIdx = startY * gridW + startX;
  nodes[startIdx * NODE_FIELDS] = 0;
  nodes[startIdx * NODE_FIELDS + 1] = Math.abs(goalX - startX) + Math.abs(goalY - startY); // f
  nodes[startIdx * NODE_FIELDS + 4] = -1; // parentDir

  const openHeap = new MinHeap<{ f: number; x: number; y: number }>();
  openHeap.push({ f: Math.abs(goalX - startX) + Math.abs(goalY - startY), x: startX, y: startY });

  while (openHeap.size > 0) {
    const current = openHeap.pop()!;
    const cx = current.x;
    const cy = current.y;
    const cIdx = cy * gridW + cx;

    if (closedFlags[cIdx]) continue;
    closedFlags[cIdx] = 1;

    if (cx === goalX && cy === goalY) break;

    const currentG = nodes[cIdx * NODE_FIELDS];
    const currentDir = nodes[cIdx * NODE_FIELDS + 4];

    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d].dx;
      const ny = cy + DIRS[d].dy;
      if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;

      const nIdx = ny * gridW + nx;
      if (closedFlags[nIdx]) continue;

      const cellCost = grid[nIdx];
      if (cellCost >= BLOCKED_COST) continue;

      let moveCost = 1 + cellCost;
      if (currentDir >= 0 && currentDir !== d) {
        moveCost += BEND_PENALTY;
      }

      const newG = currentG + moveCost;
      const nGOffset = nIdx * NODE_FIELDS;

      if (newG < nodes[nGOffset]) {
        const newF = newG + Math.abs(goalX - nx) + Math.abs(goalY - ny);
        nodes[nGOffset] = newG;
        nodes[nIdx * NODE_FIELDS + 1] = newF;
        nodes[nIdx * NODE_FIELDS + 2] = cx;
        nodes[nIdx * NODE_FIELDS + 3] = cy;
        nodes[nIdx * NODE_FIELDS + 4] = d;
        openHeap.push({ f: newF, x: nx, y: ny });
      }
    }
  }

  const goalIdx = goalY * gridW + goalX;
  if (nodes[goalIdx * NODE_FIELDS] === Infinity) {
    return [{ x: sourceX, y: sourceY }, { x: destX, y: destY }];
  }

  // Reconstruct path
  const gridPath: Vec2[] = [];
  let cx = goalX, cy = goalY;
  while (cx !== startX || cy !== startY) {
    gridPath.push({ x: cx, y: cy });
    const idx = cy * gridW + cx;
    cx = nodes[idx * NODE_FIELDS + 2];
    cy = nodes[idx * NODE_FIELDS + 3];
  }
  gridPath.push({ x: startX, y: startY });
  gridPath.reverse();

  const simplified = simplifyPath(gridPath);
  return orthogonalize(simplified, sourceX, sourceY, destX, destY);
}
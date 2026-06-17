const CELL_SIZE = 5;
const BLOCKED_COST = 1e7;
const WIRE_CROSS_COST = 8;
const WIRE_PROXIMITY_COST = 2;
const SAME_SOURCE_BONUS = -6;
const WRONG_SIDE_COST = 30;
const BEND_PENALTY = 3;
const GATE_BUFFER_RATIO = 0.2;
const MIDPOINT_COST_SCALE = 0.15;

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
          if (proxityCost > 0) {
            setCellCost(grid, gridW, gridH, gx, y - 1, proxityCost);
            setCellCost(grid, gridW, gridH, gx, y + 1, proxityCost);
          }
        }
      } else if (Math.abs(p0.x - p1.x) < 1) {
        const x = toGrid(p0.x);
        const gy0 = toGrid(Math.min(p0.y, p1.y));
        const gy1 = toGrid(Math.max(p0.y, p1.y));
        for (let gy = gy0; gy <= gy1; gy++) {
          setCellCost(grid, gridW, gridH, x, gy, crossCost);
          if (proxityCost > 0) {
            setCellCost(grid, gridW, gridH, x - 1, gy, proxityCost);
            setCellCost(grid, gridW, gridH, x + 1, gy, proxityCost);
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

function lineHitsObstacle(
  y: number, x1: number, x2: number,
  obstacles: GateObstacle[],
  sourceGateX: number, sourceGateY: number,
  destGateX: number, destGateY: number,
): boolean {
  const xMin = Math.min(x1, x2);
  const xMax = Math.max(x1, x2);
  const pad = 4;
  for (const obs of obstacles) {
    if (obs.x === sourceGateX && obs.y === sourceGateY) continue;
    if (obs.x === destGateX && obs.y === destGateY) continue;
    const bx = obs.w * GATE_BUFFER_RATIO;
    const by = obs.h * GATE_BUFFER_RATIO;
    if (rectsOverlap(xMin, y - pad, xMax - xMin, pad * 2,
                     obs.x - bx, obs.y - by, obs.w + bx * 2, obs.h + by * 2, 0)) {
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

function balancePath(
  path: Vec2[],
  sourceX: number, destX: number,
  obstacles: GateObstacle[],
  sourceGateX: number, sourceGateY: number,
  destGateX: number, destGateY: number,
  routedSegments: RoutedSegment[],
): Vec2[] {
  if (path.length < 4) return path;

  const GRID = 5;
  const snap5 = (v: number) => Math.round(v / GRID) * GRID;
  const midX = snap5((sourceX + destX) / 2);

  const result: Vec2[] = path.map(p => ({ ...p }));

  const verticals: { i0: number; i1: number; x: number; len: number }[] = [];
  for (let i = 0; i < result.length - 1; i++) {
    if (Math.abs(result[i].x - result[i + 1].x) < 1) {
      const len = Math.abs(result[i].y - result[i + 1].y);
      if (len >= GRID) {
        verticals.push({ i0: i, i1: i + 1, x: result[i].x, len });
      }
    }
  }

  if (verticals.length === 0) return result;

  const primary = verticals.reduce((a, b) => a.len > b.len ? a : b);

  const currentX = primary.x;
  if (Math.abs(currentX - midX) < GRID) return result;

  const newX = snap5(midX);
  if (newX <= snap5(sourceX + 10) || newX >= snap5(destX - 10)) return result;

  const testResult: Vec2[] = result.map(p => ({ ...p }));
  testResult[primary.i0].x = newX;
  testResult[primary.i1].x = newX;

  const segMinX = Math.min(testResult[primary.i0].x, testResult[primary.i1].x);
  const segMinY = Math.min(testResult[primary.i0].y, testResult[primary.i1].y);
  const segMaxX = Math.max(testResult[primary.i0].x, testResult[primary.i1].x);
  const segMaxY = Math.max(testResult[primary.i0].y, testResult[primary.i1].y);

  for (const obs of obstacles) {
    if (obs.x === sourceGateX && obs.y === sourceGateY) continue;
    if (obs.x === destGateX && obs.y === destGateY) continue;
    const bx = Math.ceil(obs.w * GATE_BUFFER_RATIO);
    const by = Math.ceil(obs.h * GATE_BUFFER_RATIO);
    if (rectsOverlap(
      segMinX - 2, segMinY, segMaxX - segMinX + 4, segMaxY - segMinY,
      obs.x - bx, obs.y - by, obs.w + bx * 2, obs.h + by * 2, 0,
    )) {
      return result;
    }
  }

  for (const seg of routedSegments) {
    for (let i = 0; i < seg.points.length - 1; i++) {
      const sp0 = seg.points[i], sp1 = seg.points[i + 1];
      if (Math.abs(sp0.x - sp1.x) < 1) {
        const sMinY = Math.min(sp0.y, sp1.y);
        const sMaxY = Math.max(sp0.y, sp1.y);
        if (Math.abs(newX - sp0.x) < GRID && segMinY < sMaxY && segMaxY > sMinY) {
          return result;
        }
      }
    }
  }

  return testResult;
}

/**
 * Takes a grid-aligned path (all segments 5px H or V in grid coords) and converts
 * it to canvas coordinates with exact port endpoints, ensuring every segment
 * is purely horizontal or vertical (no diagonals).
 *
 * The grid path starts at startX,startY and ends at goalX,goalY in grid coords.
 * We snap the first/last points to exact port positions, then insert short
 * corrective segments to maintain orthogonality.
 */
function orthogonalize(
  gridPath: Vec2[],
  sourceX: number, sourceY: number,
  destX: number, destY: number,
): Vec2[] {
  if (gridPath.length <= 1) {
    return [{ x: sourceX, y: sourceY }, { x: destX, y: destY }];
  }

  // Convert grid coords to canvas coords
  const canvas = gridPath.map(p => ({ x: toCanvas(p.x), y: toCanvas(p.y) }));

  if (canvas.length === 2) {
    return [{ x: sourceX, y: sourceY }, { x: destX, y: destY }];
  }

  // Determine initial direction from grid path
  const firstDir = gridPath[1].x > gridPath[0].x ? 'R' :
                   gridPath[1].x < gridPath[0].x ? 'L' :
                   gridPath[1].y > gridPath[0].y ? 'D' : 'U';
  const lastDir = gridPath[gridPath.length - 1].x > gridPath[gridPath.length - 2].x ? 'R' :
                  gridPath[gridPath.length - 1].x < gridPath[gridPath.length - 2].x ? 'L' :
                  gridPath[gridPath.length - 1].y > gridPath[gridPath.length - 2].y ? 'D' : 'U';

  // Build the result starting from the snapped source
  const result: Vec2[] = [{ x: sourceX, y: sourceY }];

  // The second point: from source, go in the first direction to reach the grid path
  // If A* went horizontal first, align second point's Y with source Y
  // If A* went vertical first, align second point's X with source X
  if (firstDir === 'R' || firstDir === 'L') {
    // Horizontal first: second point has same Y as source, X from grid path
    result.push({ x: canvas[1].x, y: sourceY });
  } else {
    // Vertical first: second point has same X as source, Y from grid path
    result.push({ x: sourceX, y: canvas[1].y });
  }

  // Middle points (2 through n-3): use grid coordinates directly,
  // snapping to ensure orthogonality with the previous point
  for (let i = 2; i < canvas.length - 1; i++) {
    const prev = result[result.length - 1];
    const gridPt = canvas[i];
    // Determine segment direction from grid path
    const dx = gridPath[i].x - gridPath[i - 1].x;
    const dy = gridPath[i].y - gridPath[i - 1].y;
    if (dx !== 0) {
      // Horizontal segment
      result.push({ x: gridPt.x, y: prev.y });
    } else {
      // Vertical segment
      result.push({ x: prev.x, y: gridPt.y });
    }
  }

  // Last bend point: from second-to-last canvas point, go in the direction
  // that connects to the destination
  if (canvas.length > 2) {
    const prev = result[result.length - 1];
    if (lastDir === 'R' || lastDir === 'L') {
      // Horizontal approach to dest: align Y with dest Y
      result.push({ x: canvas[canvas.length - 2].x, y: destY });
    } else {
      // Vertical approach to dest: align X with dest X
      result.push({ x: destX, y: canvas[canvas.length - 2].y });
    }
  }

  // Final point: snapped destination
  result.push({ x: destX, y: destY });

  // Deduplicate and remove zero-length segments
  const clean: Vec2[] = [result[0]];
  for (let i = 1; i < result.length; i++) {
    const prev = clean[clean.length - 1];
    const curr = result[i];
    // Skip duplicate points
    if (Math.abs(prev.x - curr.x) < 1 && Math.abs(prev.y - curr.y) < 1) continue;
    // Skip colinear points (same direction as previous segment)
    if (clean.length >= 2) {
      const prevPrev = clean[clean.length - 2];
      const prevDx = prev.x - prevPrev.x;
      const prevDy = prev.y - prevPrev.y;
      const currDx = curr.x - prev.x;
      const currDy = curr.y - prev.y;
      // Same direction: colinear, merge
      if ((prevDx > 0 && currDx > 0) || (prevDx < 0 && currDx < 0) ||
          (prevDy > 0 && currDy > 0) || (prevDy < 0 && currDy < 0)) {
        if ((prevDx !== 0 && currDy === 0 && prevDy === 0) ||
            (prevDy !== 0 && currDx === 0 && prevDx === 0)) {
          clean[clean.length - 1] = curr;
          continue;
        }
      }
    }
    clean.push(curr);
  }

  // Final orthogonality check: insert missing correction segments
  const final: Vec2[] = [clean[0]];
  for (let i = 1; i < clean.length; i++) {
    const prev = final[final.length - 1];
    const curr = clean[i];
    const dx = Math.abs(curr.x - prev.x);
    const dy = Math.abs(curr.y - prev.y);
    if (dx >= 1 && dy >= 1) {
      // Diagonal — insert a correction point
      // Choose direction based on which creates a shorter correction
      final.push({ x: curr.x, y: prev.y });
    }
    final.push(curr);
  }

  return final;
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
    const bufferX = Math.ceil(obs.w * GATE_BUFFER_RATIO);
    const bufferY = Math.ceil(obs.h * GATE_BUFFER_RATIO);
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

  const midGridX = toGrid(Math.round((sourceX + destX) / 2));
  const y0 = Math.min(startY, goalY);
  const y1 = Math.max(startY, goalY);
  const x0 = Math.min(startX, goalX);
  const x1 = Math.max(startX, goalX);
  if (x1 > x0) {
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const idx = gy * gridW + gx;
        const dist = Math.abs(gx - midGridX);
        const cost = dist * MIDPOINT_COST_SCALE;
        if (cost > 0 && grid[idx] < BLOCKED_COST) {
          grid[idx] += cost;
        }
      }
    }
  }

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
  const orthogonal = orthogonalize(simplified, sourceX, sourceY, destX, destY);
  return balancePath(orthogonal, sourceX, destX, obstacles, sourceGateX, sourceGateY, destGateX, destGateY, routedSegments);
}
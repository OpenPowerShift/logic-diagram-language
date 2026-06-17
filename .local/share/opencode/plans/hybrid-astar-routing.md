# Wire Routing Overhaul: Hybrid A* Plan

**Date**: 2026-06-17
**Status**: Draft — awaiting approval

## Problem Statement

The current channel-based wire routing has fundamental issues that patching cannot fix:

1. **Right-side gate entry**: `in_3->or_6` in Boolean Algebra enters the OR gate from the right (channel x=457 vs gate right edge x=450). Root cause: channel must be >= `fx + MIN_CHANNEL_SPACING`, which can exceed the destination gate width, forcing the final segment to travel leftward through the gate body.

2. **Excessive crossovers**: Boolean Algebra has 5 wire crossings; Motor Control Circuit has 4. The greedy channel-selection approach has no global view of wire interactions.

3. **Extreme detours**: `or_6->out_5` in Boolean Algebra routes via a perimeter path far below all obstacles, when a shorter path exists.

4. **Sequential blocking**: Earlier wires occupy channels and block later wires. The depth-sorted routing order helps but cannot guarantee optimal global routing.

5. **Future constraints**: Right-to-left logic flow, variable-sized symbols, and user-defined objects (SYMBOL) will break the current left-to-right assumptions entirely.

## Approach: Hybrid A* Routing

Keep the current channel-based router as a **fast path** for simple wires. Use **A* pathfinding on a discretised grid** as fallback for any wire that would create a right-side entry, pass through a gate body, cause unnecessary crossovers, or exceed a bend count threshold.

### Why A* and not alternatives?

| Approach | Pros | Cons |
|---|---|---|
| **Full A* replacement** | Uniform, one algorithm | Slow for simple wires; re-implements channel optimisations as cost heuristics |
| **Negotiated congestion (rip-up & reroute)** | Globally optimal wire placement | Overkill for <=50 wires; convergence not guaranteed; 50-500ms |
| **Maze routing (Lee/BFS)** | Guaranteed path if one exists | Explores entire grid; 10-100ms per wire |
| **Hybrid A* (chosen)** | Fast for easy wires; A* handles hard cases; <=10ms total | Slightly more code than pure channel |

### Grid Parameters

| Parameter | Value | Rationale |
|---|---|---|
| Cell size | **5px** | 240x160 grid on 1200x800 canvas; aligns to key spacings (20, 30, 60); max 2.5px snap error on ports |
| Grid coordinate system | Fixed, canvas-aligned | No per-wire coordinate translation; stable obstacle/wire overlay |
| Search bounds | Bounding box of source+dest+all obstacles, padded 40px H / 60px V | Typical search region: 3K-10K cells; dynamic expansion on failure |
| Gate body cost | **Infinity** (1e7) | Hard constraint: wires must never enter gate bodies |
| Gate body buffer | **+1 cell (5px)** expansion | Enforces MIN_WIRE_SPACING around gates |
| Existing wire cost | **8** per cell | Router will detour up to 40px to avoid a crossing |
| Wrong-side entry zone | **30** per cell | Cells to the right of a destination input port; router will detour up to 150px to avoid right-side entry |
| Direction change penalty | **+3** per bend | Discourages excessive bends; equivalent to 15px of straight routing |
| Diagonal moves | **Prohibited** | 4-connectivity only (Manhattan routing) |
| Heuristic | Manhattan distance | Admissible for uniform-cost grid with 4-connectivity |

### Architecture

```
Wire Routing Pipeline (per destination node):

1. Fast path (existing channel-based router):
   - Compute channel X (shared or individual)
   - Try tryChannel with obstacle checks
   - Validate: no gate collision, no right-side entry, no excessive bend count
   - If valid -> use this path, skip A*

2. A* fallback:
   - Reset cost grid to base cost (1)
   - Rasterize gate bodies + buffer as blocked (Infinity)
   - Rasterize previously-routed wires as penalty (8)
   - Rasterize wrong-side entry zones (30)
   - Run A* from source port to destination port
   - Simplify path (direction-change detection)
   - Snap endpoints to exact port coordinates
   - Return polyline
```

### Key Design Decisions

1. **Left-entry enforcement**: The wrong-side entry zone covers all grid cells that are:
   - To the right of the destination input port X
   - Within the vertical band of the destination gate's body height
   - Between the channel X and the destination port X
   
   This makes A* strongly prefer entering from the left, only entering from the right as a last resort.

2. **Crossover costing**: As each wire is routed, its segments are added to the cost grid. Later wires see these as soft obstacles (cost 8) and prefer to route around them. This naturally minimises crossings without needing a negotiated congestion pass.

3. **Simplification**: Raw A* paths are grid-cell polylines (up to hundreds of points). Direction-change detection reduces these to 2-5 vertices (matching current output quality). U-turn elimination merges pairs of bends with short intermediate segments.

4. **Routing order**: Wires are still routed in topological depth order. A* with wire penalties means later wires avoid earlier ones naturally.

5. **Shared channels**: The channel-based fast path still handles symmetric doglegs for multi-input gates. A* fallback doesn't need to understand shared channels—its cost model handles the crossover minimisation that shared channels were designed for.

6. **Future extensibility**: 
   - Right-to-left flow: set wrong-side entry zone to the LEFT of destination ports. A* is direction-agnostic.
   - Variable-sized symbols: gate bodies are just rectangles on the cost grid. Any size works.
   - User-defined objects: SYMBOL definitions contribute rectangles to the cost grid. No special-casing.

### Implementation Steps

#### Phase 1: A* Router Core (~200 lines) — NEW FILE

Create `src/renderer/astar-router.ts` containing:

- **MinHeap<T>**: Binary min-heap priority queue with push/pop/decreaseKey (~50 lines)
- **AStarNode**: Type with x, y, g, f, parentX, parentY, parentDir, closed flag
- **routeWireAStar()**: Main function
- **Cost grid setup**: Rasterize gate bodies + buffer, wire segments, wrong-side zones
- **A* search**: 4-connectivity, Manhattan heuristic, bend penalty
- **Path simplification**: Direction-change detection + U-turn elimination
- **Endpoint snapping**: Snap first/last points to exact port coordinates

#### Phase 2: Integration (~100 lines changes)

Modify `routeWire()` in `layout.ts`:

1. Try channel-based routing first (existing `tryChannel` code)
2. Validate result:
   - No intermediate gate collision (existing check)
   - No right-side entry (new: final segment must not travel leftward to reach a gate input)
   - Path has at most 5 segments (new: excessive bends trigger A*)
3. If valid -> use channel path, record segments
4. If invalid -> call `routeWireAStar()` with cost grid
5. Record A* result in `routedHorizontals`/`routedVerticals`

Remove from `layout.ts`:
- Strategy A (channel past rightmost obstacle)
- Strategy B (perimeter above/below)
- Strategy C (offset perimeter paths)
- The fallback that produces invalid paths
- `findClearY()` helper (A* handles detours)

Keep in `layout.ts`:
- Channel computation (shared/individual channels for fast path)
- `tryChannel()` for the fast path
- Wire routing loop structure and depth ordering
- `routedHorizontals`/`routedVerticals` tracking (used by A* cost grid too)
- `findWireCrossings()` (diagnostic utility)

#### Phase 3: Validation & Cleanup

- Add compliance test: "no wire enters a gate from the wrong side"
- Add test: "A* fallback produces paths for Boolean Algebra without right-side entry"
- Add test: "A* fallback produces paths for Motor Control Circuit with fewer crossovers"
- Verify all 170+ existing tests still pass
- Remove Strategy C code and debug test files

#### Phase 4: Spec & Documentation Update

Update `spec/sections/layout-rules.adoc`:
- Replace Wire Routing section (lines 56-68) with Hybrid A* description
- Add "Left-side entry" rule
- Add "Crossover minimisation via cost grid" rule
- Update pipeline (step 9) to mention A* fallback

Update `IMPLEMENTATION.md`:
- Change Wire Routing status to describe Hybrid A*
- Add A* router as new feature row

### Lines of Code Estimate

| Component | Lines | Notes |
|---|---|---|
| A* router (`astar-router.ts`) | ~200 | MinHeap, routeWireAStar, simplifyPath, cost rasterisation |
| Integration in `layout.ts` | ~100 | Validation, fallback call, cleanup of old strategies |
| Removed code (`routeWire` strategies) | ~280 | Strategies A, B, C, findClearY, channelClear, etc. |
| **Net change** | **~+20** | Much simpler code overall |

### Risk Assessment

| Risk | Mitigation |
|---|---|
| A* too slow for large diagrams | Search bounds limit region; 38K cells is tiny; sub-10ms total for 50 wires |
| A* produces jagged paths | Direction-change penalty (+3) and U-turn elimination produce clean orthogonal paths |
| Snap error on port positions | Endpoints snapped to exact LayoutPort coordinates; mid-path cells at 5px resolution |
| Regression in existing diagrams | All 170+ existing tests must pass; A* produces equivalent or better paths |
| Future right-to-left flow | Wrong-side zone flips from right-of-port to left-of-port; A* is direction-agnostic |

### Expected Results for Current Problem Cases

**Boolean Algebra:**
- `in_3->or_6`: A* will find a path entering from the left (cost 30 penalty on right-side cells forces left-side entry)
- `or_6->out_5`: A* will route above or below `not_10` with minimal bends instead of the current extreme perimeter detour
- Expected crossing reduction: 5->2 or better

**Motor Control Circuit:**
- `in_5->or_13` and `in_7->or_13`: A* will separate channels with wire penalties, reducing crossovers
- Expected crossing reduction: 4->1 or 0

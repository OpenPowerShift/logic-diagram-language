# Implementation Status

Spec version: 0.3.0-draft
Last updated: 2026-06-17

## Legend

- **Done** — implemented and tested
- **Partial** — partially implemented (notes explain what's missing)
- **Missing** — specified but not implemented

## Language Features

| Feature | Status | Notes |
|---|---|---|
| Boolean expressions (AND, OR, NOT) | Done | Precedence: NOT > AND > OR, parenthetical grouping |
| Derived operators (NAND, NOR, XOR, XNOR) | Missing | AST types exist; parser ignores keywords |
| Expression continuation lines | Done | |
| Inversion rendering (GATES / BUBBLES) | Done | Double-inversion cancellation included |
| Object declarations | Done | `SYMBOL_NAME#ID` syntax |
| Port metadata (`.Name`, `.Description`, `.Style`) | Partial | `.Name` and `.Description` work; `.Style` parsed but never applied to port rendering |
| Implicit ports | Done | Input/output ports created from expression vars |
| Attribute declarations | Done | |
| Link declarations (`.LINK`) | Missing | Parser does not handle `.LINK = STRING` |
| `OPTION INVERSION` | Done | GATES (default) and BUBBLES |
| `OPTION PORT_STYLE` | Done | CIRCLE (default) and SQUARE |
| `OPTION GATE_INPUT_STYLE` | Done | EXPAND (default) and BARS (BARS routing known-broken, out of scope) |
| `OPTION OUTPUT_ORDER` | Done | DECLARATION (default) keeps declared output order; AUTO reorders outputs by source gate Y to avoid crossings |
| `OPTION LABEL_STYLE` | Missing | Only SIDE behavior exists; ABOVE_BELOW not implemented |
| `CONNECT` explicit wires | Missing | Parser stores `ConnectDecl[]` but renderer never reads them |
| `STYLE ... END STYLE` | Partial | Parser stores blocks in `StyleDecl[]` but renderer never embeds CSS |
| `STYLESHEET` loading | Missing | Parser accepts but discards |
| `SYMBOL ... END SYMBOL` definitions | Missing | Parser skips block |
| `IMPORT TEMPLATE` | Missing | Parser discards data |
| Hyperlinks (`.LINK`) | Missing | Not parsed or rendered |
| Port-level style overrides | Missing | `styleMap` built in layout but never assigned to `LayoutPort.style` |
| Common subexpression sharing | Done | Deduplication in `resolve()` for identical gate structures across outputs |

## Rendering

| Feature | Status | Notes |
|---|---|---|
| AND gate shape | Done | |
| OR gate shape | Done | |
| NOT gate shape | Done | |
| NAND, NOR, XOR, XNOR gate shapes | Missing | Not implemented |
| Input port rendering | Done | Circle and square markers |
| Output port rendering | Done | Circle and square markers |
| Port labels (Name / Description) | Done | With mixed plain+math content |
| ID labels | Done | |
| Math rendering (TeX via MathJax v4) | Done | Inline SVG embedding with baseline alignment |
| Wire routing | Done | A* pathfinding on 5px grid. Doglegs are eliminated at the *layout* level (endpoint alignment) so the A* optimum is a straight line or a clean Z-route. Cost model: obstacle avoidance (20% buffer), wrong-side entry penalty (30), wire-cross penalty (8), cross-net proximity penalty (spreads parallel wires into separate tracks), bend penalty, same-source trunk bonus. Orthogonal-only paths. No midpoint-centering bias and no post-hoc dogleg patches. |
| OR gate input ports | Done | Input ports tap the concave left **curve** (wires hit the curve edge); bounding box, output port, and all port Y positions stay grid-aligned; fixed curve depth for consistent concavity across heights |
| Inversion bubbles | Done | Input-side and output-side. Dot sits just left of the gate edge (straight bbox edge for AND/NOT; curve tap for OR), in reserved horizontal space between the incoming wire and the gate body |
| Input bars (BARS mode) | Done | |
| Layer visibility (labels/IDs toggle) | Done | |
| SVG download | Done | |
| PDF export | Done | Via canvas + jsPDF |
| CSS class injection (`ldl-*`) | Done | |
| External CSS via stylesheet | Missing | Not loaded |
| Custom symbol rendering from SVG files | Missing | Symbol definitions not processed |
| Attribute substitution in symbols | Missing | No symbol rendering pipeline |

## Editor

| Feature | Status | Notes |
|---|---|---|
| CodeMirror editor with LDL highlighting | Done | |
| Error panel | Done | Shows parse errors |
| Example selector | Done | 15 built-in examples |

## Testing

| Feature | Status | Notes |
|---|---|---|
| Parser tests | Done | 12 tests |
| Renderer tests | Done | 9 tests |
| Layout tests | Done | 17 tests |
| Layout invariants | Done | `tests/unit/invariants.spec.ts` — a fixed set of universal layout rules (pure functions over `LayoutResult`) run table-driven against **every** example in `src/examples.ts` plus synthetic stress cases. Adding an example automatically gets full coverage, so we stop re-solving the same regressions per-example. Replaces the old hardcoded-example `layout-rules` / `layout-compliance` suites. |
| Math renderer tests | Done | 10 tests |
| Visual checks | Done | `render-examples` harness emits SVG per example; `rsvg-convert` → PNG for visual spot-checks against the spec |

### Layout invariants (the rules)

Each is a pure function over `LayoutResult`, asserted for all examples:

1. all port coordinates on the 5px grid (OR input-port X excepted — it taps the curve)
2. ports on the correct gate edge: AND/NOT inputs on bbox left edge; OR inputs on the
   curve; all outputs on bbox right edge
3. every wire segment is exactly horizontal or vertical
4. every wire connects source port → dest port (first/last points match the ports)
5. no dogleg: each wire is straight, or a clean Z with one vertical run ≥ `MIN_DOGLEG`
6. no cross-net vertical–vertical or horizontal–horizontal segment overlap
7. adjacent parallel segments spaced ≥ `MIN_WIRE_SPACING`
8. junction dots lie at true T-intersections (on a trunk and a branch of the same source)
9. no wire crosses a non-endpoint gate body
10. no backward (right-to-left) segments

## Routing Model

Routing is split between two layers, and the division of labour is the key design rule:

1. **Layout eliminates doglegs.** Gate input-port Y positions are aligned to their source
   output Y (straight-through), or kept at least `MIN_DOGLEG` (30px) apart (clean Z-route).
   Outputs are re-aligned to their source gate output Y. Because endpoints are aligned, the
   A* optimum is naturally a straight line or a single clean Z — no dogleg post-processing.
2. **A* draws the wire** between the (now aligned) endpoints, avoiding obstacles and other
   wires. Parallel wires are spread into separate tracks by a cross-net proximity penalty
   plus generous inter-column spacing (readability over compactness).

A *dogleg* (forbidden) is a small/needless jog: a vertical run shorter than `MIN_DOGLEG`
between two horizontal segments. A *Z-route* (allowed) is `H → V(≥MIN_DOGLEG) → H`.

### A* Router Constants

| Constant | Value | Purpose |
|---|---|---|
| CELL_SIZE | 5 | Grid resolution (all positions snap to 5px) |
| BLOCKED_COST | 1e7 | Impassable cell (gate body + 20% buffer) |
| WIRE_CROSS_COST | 8 | Penalty per cell overlapping a routed wire |
| WIRE_PROXIMITY_COST | n | Penalty near an existing wire; widened so parallel wires separate into distinct tracks |
| WRONG_SIDE_COST | 30 | Penalty for entering gate from right side |
| BEND_PENALTY | — | Penalty for direction change; tuned so the optimum has ≤2 bends |
| SAME_SOURCE_BONUS | — | Discount for sharing a trunk with same-source wires (fan-out) |
| GATE_BUFFER_RATIO | 0.2 | 20% buffer zone around gate bodies |

(Removed: `MIDPOINT_COST_SCALE` midpoint-centering bias and the `fixSourceDogleg` /
`fixDestDogleg` / `removeSmallZigzags` / `balancePath` post-processing patches — superseded
by layout-level endpoint alignment.)

Key files:
- `src/renderer/astar-router.ts`: A* router, cost grid, orthogonalize()
- `src/renderer/layout.ts`: endpoint-alignment passes, fan-out trunk/branches, junction
  dots, OR curve-tap ports, channel spacing, allObstacles
- `src/renderer/gates.ts`, `src/renderer/svg-renderer.ts`: OR curve geometry, bubble placement

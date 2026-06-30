# Implementation Status

Spec version: 0.3.0-draft
Last updated: 2026-06-17

## Legend

- **Done** — implemented and tested
- **Partial** — partially implemented (notes explain what's missing)
- **Missing** — specified but not implemented

## Language Features

| Feature                                           | Status  | Notes                                                                                                        |
| ------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| Boolean expressions (AND, OR, NOT)                | Done    | Precedence: NOT > AND > OR, parenthetical grouping                                                           |
| Consumed intermediates / signal sharing           | Done    | A name referenced in another assignment is shared (its driver fans out) and NOT drawn as an output, unless it's a sink, a feedback self-reference, or forced with `NAME.OUT = TRUE`. `resolveName` memoises name→driver. A consumed intermediate with `.Name`/`.Description` gets a net label at its fan-out junction (`LayoutResult.labels`), registered as a routing obstacle so wires route around it. See spec `expressions.adoc` |
| Feedback / seal-in loops                          | Done    | An output used inside its own (cyclic) definition loops back instead of becoming a new input; drawn as a loop-back lane below the diagram (e.g. Breaker Failure SEL-751A) |
| SEL function blocks (TIMER/SR/RISING/FALLING/COMPARE) | Done    | Function-call primitives in expressions: `TIMER#id(in, pu, do)`, `SR(set, reset).Q/.NQ`, `RISING/FALLING(in)`, `COMPARE(+, −)`. SEL-style symbols (TIMER = diagonal ramp, PU upper-left / DO lower-right). Block name above / description below the body. A defined output used as a block argument is substituted with its driver (fan-out), not duplicated. See spec `function-blocks.adoc`; examples "SEL Function Blocks", "Complex Protection (SEL)" |
| Generic block (FB)                                | Done    | `FB#id(PHASE=IA, EARTH=IN, …).TRIP` — square box, labelled inputs from the (optionally named) args, named outputs from `.port` selectors, name centred in the box, description below. Box scales with the input/output counts and is sized to encompass its ports on the grid (no jogs). Example "Generic Block (FB)" |
| Derived operators (NAND, NOR, XOR, XNOR)          | Missing | AST types exist; parser ignores keywords                                                                     |
| Expression continuation lines                     | Done    |                                                                                                              |
| Inversion rendering (GATES / BUBBLES)             | Done    | Double-inversion cancellation included. Bubbles follow their inverted source to the port it lands on (sources map to ports in ascending-Y order), so `... AND NOT X` with INPUT_ORDER=AUTO bubbles the correct input |
| Object declarations                               | Done    | `SYMBOL_NAME#ID` syntax                                                                                      |
| Port metadata (`.Name`, `.Description`, `.Style`) | Partial | `.Name` and `.Description` work; `.Style` parsed but never applied to port rendering                         |
| Implicit ports                                    | Done    | Input/output ports created from expression vars                                                              |
| Attribute declarations                            | Done    |                                                                                                              |
| Link declarations (`.LINK`)                       | Missing | Parser does not handle `.LINK = STRING`                                                                      |
| `OPTION INVERSION`                                | Done    | GATES (default) and BUBBLES                                                                                  |
| `OPTION PORT_STYLE`                               | Done    | CIRCLE (default) and SQUARE                                                                                  |
| `OPTION GATE_INPUT_STYLE`                         | Done    | EXPAND (default) and BARS (fixed 2026-06: bar-tap port Ys evenly distributed across gate body; fan-in channel interleave above/below) |
| `OPTION OUTPUT_ORDER`                             | Done    | DECLARATION (default) keeps declared output order; AUTO reorders outputs by source gate Y (opt-in: can add output-column congestion in some diagrams) |
| `OPTION INPUT_ORDER`                              | Done    | AUTO (default) reorders inputs via Sugiyama barycentre; DECLARATION keeps declared order                     |
| `OPTION COMPACTNESS` / `OPTION SIZE`               | Done    | NORMAL (default) / COMPACT_V (tighten rows) / COMPACT_H (tighten columns) / COMPACT (both) / SPACIOUS; min gaps still enforced. `SIZE` is the canonical name; `COMPACTNESS` kept as deprecated alias |
| `OPTION LABEL_STYLE`                              | Missing | Only SIDE behavior exists; ABOVE_BELOW not implemented                                                       |
| `CONNECT` explicit wires                          | Missing | Parser stores `ConnectDecl[]` but renderer never reads them                                                  |
| `STYLE ... END STYLE`                             | Partial | Parser stores blocks in `StyleDecl[]` but renderer never embeds CSS                                          |
| `STYLESHEET` loading                              | Missing | Parser accepts but discards                                                                                  |
| `SYMBOL ... END SYMBOL` definitions               | Missing | Parser skips block                                                                                           |
| `IMPORT TEMPLATE`                                 | Missing | Parser discards data                                                                                         |
| Hyperlinks (`.LINK`)                              | Missing | Not parsed or rendered                                                                                       |
| Port-level style overrides                        | Missing | `styleMap` built in layout but never assigned to `LayoutPort.style`                                          |
| Common subexpression sharing                      | Done    | Deduplication in `resolve()` for identical gate structures across outputs                                    |

## Rendering

| Feature                                | Status  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AND gate shape                         | Done    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| OR gate shape                          | Done    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| NOT gate shape                         | Done    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| NAND, NOR, XOR, XNOR gate shapes       | Missing | Not implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Input port rendering                   | Done    | Circle and square markers                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Output port rendering                  | Done    | Circle and square markers                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Port labels (Name / Description)       | Done    | With mixed plain+math content                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ID labels                              | Done    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Math rendering (TeX via MathJax v4)    | Done    | Inline SVG embedding with baseline alignment                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Wire routing                           | Done    | A* pathfinding on 5px grid. Doglegs are eliminated at the *layout* level (endpoint alignment) so the A* optimum is a straight line or a clean Z-route. Cost model: obstacle avoidance (20% buffer), wrong-side entry penalty (30), wire-cross penalty (8), cross-net proximity penalty (spreads parallel wires into separate tracks), bend penalty, same-source trunk bonus. Orthogonal-only paths. No midpoint-centering bias and no post-hoc dogleg patches. |
| OR gate input ports                    | Done    | Input ports tap the concave left **curve** (wires hit the curve edge); bounding box, output port, and all port Y positions stay grid-aligned; fixed curve depth for consistent concavity across heights                                                                                                                                                                                                                                                        |
| Inversion bubbles                      | Done    | Input-side and output-side. Dot sits just left of the gate edge (straight bbox edge for AND/NOT; curve tap for OR), in reserved horizontal space between the incoming wire and the gate body                                                                                                                                                                                                                                                                   |
| Input bars (BARS mode)                 | Done    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Layer visibility (labels/IDs toggle)   | Done    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SVG download                           | Done    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PDF export                             | Done    | Via canvas + jsPDF                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| CSS class injection (`ldl-*`)          | Done    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `STYLE ... END STYLE`                             | Done    | Raw CSS extracted by the tokenizer (bypassing the LDL lexer) and injected into the SVG `<defs><style>`. `#ID` selectors target the semantic SVG ids emitted on gates/blocks/inputs/outputs. `END` or `END STYLE` both close the block |
| `OPTION STROKE_WIDTH`                            | Done    | Global stroke-width knob (px); applied via CSS to every symbol body, bubble, input bar, and wire |
| `OPTION HIDE_JUNCTIONS`                          | Done    | TRUE / FALSE (default). Hides all junction dots via CSS class `ldl-hide-dots` on the SVG root |
| `OPTION SIZE` / `OPTION COMPACTNESS`              | Done    | `SIZE` is the canonical name; `COMPACTNESS` is a deprecated alias. NORMAL (default) / COMPACT_V / COMPACT_H / COMPACT / SPACIOUS; explicit `[v,h]` factors also accepted |
| Custom symbol rendering from SVG files | Missing | Symbol definitions not processed                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Attribute substitution in symbols      | Missing | No symbol rendering pipeline                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Editor

| Feature                                 | Status | Notes                |
| --------------------------------------- | ------ | -------------------- |
| CodeMirror editor with LDL highlighting | Done   |                      |
| Error panel                             | Done   | Shows parse errors   |
| Example selector                        | Done   | 15 built-in examples |

## Testing

| Feature             | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parser tests        | Done   | 12 tests                                                                                                                                                                                                                                                                                                                                                                                              |
| Renderer tests      | Done   | 9 tests                                                                                                                                                                                                                                                                                                                                                                                               |
| Layout tests        | Done   | 17 tests                                                                                                                                                                                                                                                                                                                                                                                              |
| Layout invariants   | Done   | `tests/unit/invariants.spec.ts` — a fixed set of universal layout rules (pure functions over `LayoutResult`) run table-driven against **every** example in `src/examples.ts` plus synthetic stress cases. Adding an example automatically gets full coverage, so we stop re-solving the same regressions per-example. Replaces the old hardcoded-example `layout-rules` / `layout-compliance` suites. |
| Math renderer tests | Done   | 10 tests                                                                                                                                                                                                                                                                                                                                                                                              |
| Graph tests         | Done   | `tests/unit/graph.spec.ts` — unit tests for the extracted `buildGraph` module (flattening, intermediate sharing, `.OUT`, bubble absorption)                                                                                                                                                                                                                                                            |
| Visual regression   | Done   | `tests/unit/visual-regression.spec.ts` — a deterministic, id-independent geometry digest of every example, snapshotted. A behaviour-preserving refactor leaves snapshots unchanged; a deliberate layout change is a reviewable diff (`vitest -u` to accept). The safety net for the layout refactor + placement work |
| Bend/crossing metrics | Done | `tests/unit/bend-metrics.spec.ts` — per-example straight/bent/bends/crossings dashboard, snapshotted. Quantifies placement quality so the bend-aware coordinate work (Issue 10) is measurable and guarded |
| Visual checks       | Done   | `render-examples` harness emits SVG per example; `rsvg-convert` → PNG for visual spot-checks against the spec                                                                                                                                                                                                                                                                                         |

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
   A\* optimum is naturally a straight line or a single clean Z — no dogleg post-processing.
2. **A\* draws the wire** between the (now aligned) endpoints, avoiding obstacles and other
   wires. Parallel wires are spread into separate tracks by a cross-net proximity penalty
   plus generous inter-column spacing (readability over compactness).

A _dogleg_ (forbidden) is a small/needless jog: a vertical run shorter than `MIN_DOGLEG`
between two horizontal segments. A _Z-route_ (allowed) is `H → V(≥MIN_DOGLEG) → H`.

### Routing Performance

`routeWireAStar` tries cheap deterministic routes before any grid search, so cost scales
with diagram complexity rather than canvas size:

1. **Straight line** when source and dest share a Y and nothing blocks.
2. **Clean Z** (`tryCleanZ`): a horizontal–vertical–horizontal route whose three segments
   clear all gate bodies and all other nets — covers the common case with no allocation.
3. **A\* grid search** only when neither fast path applies. The grid is **bounded to the
   source→dest bounding box plus a 160px margin** (not the whole canvas); if the goal is
   unreachable in that region it retries on the full canvas. This keeps per-wire allocation
   and search proportional to the wire's span.

Measured layout time (parse → layout, warm): trivial/medium examples 1–3 ms; a 60-node
balanced tree ~65 ms; a pathological 92-node single-30-input-OR ~0.6 s. Budget: < 0.5 s
medium, < 1 s large. The clean-Z fast path and bounded grid together cut the worst case
from ~2.0 s to ~0.6 s.

### A\* Router Constants

| Constant            | Value | Purpose                                                                                |
| ------------------- | ----- | -------------------------------------------------------------------------------------- |
| CELL_SIZE           | 5     | Grid resolution (all positions snap to 5px)                                            |
| BLOCKED_COST        | 1e7   | Impassable cell (gate body + 20% buffer)                                               |
| WIRE_CROSS_COST     | 8     | Penalty per cell overlapping a routed wire                                             |
| WIRE_PROXIMITY_COST | n     | Penalty near an existing wire; widened so parallel wires separate into distinct tracks |
| WRONG_SIDE_COST     | 30    | Penalty for entering gate from right side                                              |
| BEND_PENALTY        | —     | Penalty for direction change; tuned so the optimum has ≤2 bends                        |
| SAME_SOURCE_BONUS   | —     | Discount for sharing a trunk with same-source wires (fan-out)                          |
| GATE_BUFFER_RATIO   | 0.2   | 20% buffer zone around gate bodies                                                     |
| GATE_BUFFER_MIN     | 10    | Min horizontal clearance (px) wires keep from a gate body                              |
| GATE_BUFFER_MIN_Y   | 20    | Min vertical clearance (px) a passing horizontal wire keeps off a gate top/bottom (2× wire gap) |

(Removed: `MIDPOINT_COST_SCALE` midpoint-centering bias and the `fixSourceDogleg` /
`fixDestDogleg` / `removeSmallZigzags` / `balancePath` post-processing patches — superseded
by layout-level endpoint alignment.)

Key files:

- `src/renderer/graph.ts`: **Phase 1 — `buildGraph`** (AST → flattened logic graph: resolve &
  share signals, BUBBLES absorption, depth assignment). Extracted from `layout.ts` (2026-06) as
  the first step of the pipeline refactor (direction #1); pure of geometry and unit-tested.
- `src/renderer/astar-router.ts`: A\* router, cost grid, orthogonalize()
- `src/renderer/layout.ts`: geometry — coordinate assignment, node creation, endpoint-alignment
  passes, fan-out trunk/branches, junction dots, OR curve-tap ports, channel spacing, allObstacles
- `src/renderer/gates.ts`, `src/renderer/svg-renderer.ts`: OR curve geometry, bubble placement

## SEL Function Blocks

Five SEL-style primitives in the expression language (spec: `function-blocks.adoc`).
Implemented:

- **Syntax**: function calls in expressions — `TIMER(in, pu, do)`, `SR(set, reset)`,
  `RISING(in)`, `FALLING(in)`, `COMPARE(plus, minus)` — composable/nestable like gates. An
  optional instance id is part of the name before the args (`COMPARE#C1(IA, IPK)`); settings/
  metadata via `id.Property`. A trailing `.port` selects an output (`SR#L1(S,R).NQ`); only
  referenced output ports are drawn.
- **TIMER**: settings positional or named (`PU=`/`DO=`), bare number = cycles, `0` = no delay.
- **SR**: reset-dominant default, `DOMINANT=SET` to flip; inverted output Q̄ drawn only if used.
- **COMPARE**: comparator triangle, asserts `+` ≥ `−`.
- **RISING/FALLING**: one-interval edge pulse.

Implementation steps:

1. **Lexer/parser**: in `parsePrimary`, an identifier followed by `(` parses a call; accept
   the durations the lexer already tokenises (`5cyc`, `0.5s`) and named args; optional `#id`.
2. **AST**: new `BlockNode { kind:'block', blockType, inputs, params, id? }` (separate from
   `GateNode` — carries settings and named ports).
3. **Layout** (`layout.ts` node-creation): per-block body size + ports — TIMER/RISING/FALLING
   1-in/1-out; SR S+R in, Q (+Q̄ if used) out; COMPARE +/− in, 1 out. Feed into the existing
   priority placement, routing, and feedback (latch Q loop-back already supported).
4. **Render** (`gates.ts` + `svg-renderer.ts`): SEL bodies — timer rectangle with PU/DO + edge
   glyphs, SR box with S/R/Q labels, edge step glyphs, comparator triangle with +/−.
5. **Tests/examples**: invariants over a new example per block; a seal-in built from `SR` +
   `RISING`.

## Outstanding Items (Prioritised Backlog)

Captured 2026-06 from user review. Roughly priority-ordered; tiers group by kind.

### Tier 1 — Rendering correctness (visible defects in current output)

1. **Gate symbol geometry: centres and ports must land on the 5px grid.** — **RESOLVED
   (2026-06).** Added `evenGridHeight()` (ceil to a multiple of `2*GRID` = 10px) and applied it
   in `baseNodeHeight()` and the AND/OR node-creation branch of `layout.ts`. Multi-input AND/OR
   gates now have an on-grid vertical centre, so the OR arc tip and the output port/junction dot
   all coincide on the grid. Verified: a 3-input AND/OR now reports `h=60` (even cells),
   `centre_y` and `out_y` both on-grid. All 276 layout invariants + 463 tests pass; the geometry
   snapshot shift is the intended effect (small bend/crossing deltas on Complex Protection SEL
   and Boolean Algebra — recovered in the Tier 2 work).

2. **Input/output channel allocation to prevent wire overlaps** (e.g. `FB#DAN(IN=ISET, TRIG=DAN,
   SEAL=ZZ)`). — **Effectively RESOLVED by prior infrastructure; now explicitly guarded
   (2026-06).** The nested fan-in channel pass (FANIN_SPACING-nested verticals just left of a
   gate/block) plus the obstacle-aware A* feedback routing (loop-back lanes above/below the
   body) already keep regular input fan-in and feedback loop-back verticals in distinct X
   channels. A 13-variant fuzz (`FB#DAN` with TRIG/SEAL as the self-reference, varying input
   counts, port orders, COMPACTNESS, nested-block inputs; gate seal-ins; SR/timer seal-ins)
   reports **0 cross-net vertical overlaps and 0 cross-net track-sharing** in the fan-in zone
   across all variants. Seven FB+feedback and SR/timer-seal-in cases were added to the
   robustness corpus (`tests/unit/robustness.spec.ts`) so the existing invariant #6 (no
   cross-net overlapping parallel segments) and the body-crossing / connectivity invariants now
   guard this class against regression.

### Tier 2 — Layout quality (avoidable crossovers)

3. **Better placement of single-consumer inputs to remove crossovers.** In *Labelled Gates*, `HBLK`
   would sit better **between `NEGSEQ` and `O502`** (no crossover); in *Complex Protection (SEL)*,
   `CB52A` between `RESET` and `IDIFF`** (with a little spacing) removes crossings.
   **Right approach:** this is layered-graph crossing minimisation. Today `INPUT_ORDER = AUTO` does a
   single barycentre pass and inputs keep uniform spacing in declared-ish order. Improve by
   (a) ordering each input at the **barycentre/median of its consumer's port Y** — which may place
   it *between* other inputs, not at the top/bottom; (b) iterating median ordering over all layers
   with alternating up/down sweeps until stable (standard Sugiyama); and (c) allowing **non-uniform
   row insertion** so an input can drop into a gap between two existing rows ("a little space")
   instead of pushing everything. Guard with the bend/crossing metric so no example regresses.

   **Status: RESOLVED (2026-06).** The fix is a **bounded 2-hop-downstream median reorder of the
   input column's rowMap** after the 3-iteration barycentre pass: each input's sort key becomes
   the median rank of its **consumer's consumers** (the 2-hop-downstream successors), clamped to
   ±`ceil(n/3)` ranks of its barycentre position, with the input column then integer-renumbered
   (0..n) so `assignCoordinates` packs it with uniform sequential `sep()`. A 2-hop (not 1-hop)
   median straightens paths through intermediate single-input gates like NOTs: e.g.
   HBLK → not_7 → and_8 sorts HBLK at and_8's row (not not_7's), so the full path is straight and
   the not_7→and_8 vertical doesn't cross other horizontal corridors. Inputs feeding directly
   into multi-input gates have the same 2-hop and 1-hop consumer (the gate itself), so they are
   unaffected. The clamp (`±ceil(n/3)`) prevents an input from jumping clean across the column to
   an extreme Y when its 2-hop consumer (an output or far-flung gate) sits at the end of an
   `OUTPUT_ORDER=AUTO` chain — that caused an overlap of RESET's SR-bound wire with a COMPARE
   fan-out trunk in *Shared Intermediates*. The input-count guard (`> 4`) avoids re-sorting small
   diagrams where any reorder is disruptive (Combined Logic CBFPS: `O = AB AND DC OR (NOT DC AND GF)`).

   **Measured results** (bend/crossing metric, before → after):
   - **Labelled Gates**: 22 bends / 1 crossing → 20 bends / **0 crossings** ✓
   - **Complex Protection (SEL)**: 34 bends / 8 crossings → 28 bends / **0 crossings**, H 1075→1115px (+40) ✓
   - All other examples: metrically unchanged — including Shared Intermediates (18 bends / 3 crossings) and Combined Logic CBFPS (14 bends / 0 crossings)
   - All 276 invariants + 50 robustness cases pass.

   **Earlier attempts (all reverted):**
   1. Post-placement input re-sort by consumer-port medians — stale gate-port doglegs (6 examples).
   2. All-layer iterative median Sugiyama ordering — improved metrics but broke 3 invariants.
   3. Unbounded 2-hop median as a direct Y for the input column's `assignCoordinates` initial
      centre — placed START/EXT_ALARM at extreme Ys because their 2-hop consumers were bottom
      outputs under `OUTPUT_ORDER=AUTO`; *Complex Protection (SEL)* ballooned from 1075px to
      4490px tall. Root cause: Direct Y placement bypasses the uniform `sep()` packing that
      bounds the column height. The landed fix reorders the rowMap **integer rank** instead,
      keeping `assignCoordinates`'s uniform packing so heights stay bounded.

3b. **Gate height should depend on port count ONLY, not on source spread** (spec:
    <<gate-sizing-principle>>). After the input-column packing (565d2e9) a gate's two sources can
    end up farther apart than a compact (port-count-sized) body can span. The current code expands
    the gate to keep both input wires straight — a deviation from the principle (gates grow "for
    other reasons"). **Why a naïve fix fails:** capping the height at the port-count base and
    placing ports within the fixed body was prototyped (`fitPortsToBody`) and **reverted** — it
    keeps gates compact and `oob = 0`, but breaks the **no-doglegs invariant in ~7 examples** and
    introduces cross-net wire overlaps, because two sources separated by *(inner span, inner span +
    `MIN_DOGLEG`)* cannot both reach a straight or clean-`MIN_DOGLEG` wire in a fixed body; one is
    forced into the sub-`MIN_DOGLEG` band. **Correct fix:** *gate-aware input placement* — when a
    single-consumer input feeds a compact gate, snap the input's row to the gate's compact port Y so
    the wire is straight without growing the gate. This must run in/after `assignCoordinates` (so it
    survives the later input moves that made the prototype's gate placement stale) and respect the
    column packing/height bound. Until then the gate-expansion stopgap stays. Guard with the
    no-doglegs + height-bound invariants and the bend metric.

    **Two architectures attempted (both reverted) — the real obstacle.** (1) *Fixed height + port
    projection* (`fitPortsToBody` as a late override pass): kept gates at base height, `oob = 0`, but
    broke no-doglegs in ~7 examples + added cross-net overlaps. (2) *Gate-aware input snapping*
    (size each gate for its ports at a label-safe 30px spacing, slide to align fixed sources, snap
    free single-consumer inputs to their ports): **far worse** — 83 sub-MIN doglegs across ~20
    examples, *including Simple AND Gate*. Root cause: an additive pass that changes a gate's
    **port spacing / body height** is fundamentally unsafe because **~6 downstream passes assume the
    base PORT_SPACING (15px) port layout** — the OR-curve-tap pass, single-output centring
    (`recenterOutputs`), the multi-input fan-in channel pass, the residual dogleg-killer, the
    gate–gate overlap resolver, and the input-column packing. Changing port Ys/spacing in one pass
    desynchronises all of them. **Conclusion:** this is not an additive-pass change; it needs a
    *coordinated rework* that makes per-gate port spacing a first-class property every dependent pass
    reads, done as a dedicated multi-step refactor with the invariant suite green at each step — not
    a single patch. The gate-expansion stopgap remains until that refactor is scheduled.

    **Refactor in progress** (branch `gate-port-spacing-refactor`):
    - **Step 1 — DONE.** Extracted `gateBodyHeight(n, gap)` / `gateInputPortY(top, i, gap)` as the
      single source of truth for gate vertical layout (behaviour-preserving, all snapshots
      unchanged), and added `tests/unit/gate-port-contract.spec.ts` — the contract every step must
      keep (output dead-centre; input ports ordered, in-body, ≥ PORT_SPACING apart).
    - **Step 2 — per-gate `gap` field.** Store the chosen vertical port spacing on the gate node;
      compute it label-aware (≈`MIN_PORT_GAP` when any source is a labelled input, else
      `PORT_SPACING`). Route the alignment passes' `idealYs`/height maths through `gateBodyHeight`/
      `gateInputPortY(gap)`. Behaviour-preserving while `gap` stays at `PORT_SPACING`.
    - **Step 3 — consolidate the writers.** Fold the three growth passes + the residual dogleg-killer
      into one authoritative `placeGateBodies` pass (sizes by port count via the helpers, slides to
      align fixed sources, leaves clean-`MIN_DOGLEG` doglegs); make the OR-curve, fan-in, output
      centring and protected-zone passes read-only consumers of the final port Ys. Guard with the
      contract + no-doglegs + height-bound invariants.
    - **Step 4 — gate-aware input snapping.** With sizing authoritative and gap label-safe, snap each
      free single-consumer input to its gate's port Y (room-checked against column neighbours), so
      the gate stays port-count-sized AND the wire is straight — the actual goal.

    **Steps 3–4 prototyped (reverted) — viability proven, deeper coupling found.** An authoritative
    post-pass (placed after every other gate-position pass so nothing undoes it) that sizes each gate
    by port count at a label-safe 30px gap, slides to align fixed sources, and snaps free
    single-consumer inputs **does shrink gates** — Combined Logic CBFPS `and_4` went 115px → 60–80px,
    the actual goal. But it cannot be landed as a post-pass:
    1. *Per-gate greedy positioning overlaps column neighbours* (two gates with the same sources land
       at the same Y). A follow-up overlap resolver fixes the overlaps but re-introduces doglegs by
       pushing gates apart — placement must be **joint/column-level** (in `assignCoordinates`), not
       per-gate greedy.
    2. *The coupling extends into the ROUTER.* Even where placement is correct (Simple AND: input and
       its port both at y65, perfectly aligned), the router's fan-in / clean-Z machinery still
       detours the straight wire into a 5px jog — so adopting a new gate gap/height also requires
       adapting the fan-in channel logic and the gate-buffer/clean-Z router.

    **Revised conclusion.** The full fix is a *joint column-level placement in `assignCoordinates`*
    (gate sizing + input snapping decided together with inter-gate spacing) **plus** matching changes
    to the fan-in/router — a dedicated re-engineering of the coupled placement+routing core, not an
    additive pass. Step 1 (the helpers + contract invariant) is the durable foundation landed on the
    `gate-port-spacing-refactor` branch; the stopgap (gate growth) stays on `main`.

### Tier 3 — Authoring & feature ergonomics — **RESOLVED (2026-06).**

4. **Name a gate directly: `AND#MYID` (and `OR#`, `NOT#`)**. **Done.** Added a function-call form
   `AND#ID(...)` / `OR#ID(...)` / `NOT#ID(...)` parsed in `parsePrimary` (with `parseNotExpr`
   intercepting `NOT#` so the NOT keyword isn't consumed before `parsePrimary` sees the `#`).
   `buildGraph`'s `resolve()` attaches `.Name` / `.Description` meta by id, gives a tagged gate its
   own deduplication key (`G#id`) so two gates with the same inputs but different ids stay distinct,
   and `baseNodeHeight` reserves column space for the label. The renderer shows the instance name
   above the body and description below, mirroring SEL block label placement. Test coverage: 4
   parser tests + a Named Gates example exercising `OR#ID` and `AND#ID` with `.Name`/`.Description`.

5. **Add an output by a bare port assignment: `A = FB#PROT.ALARM`.** **Done.** Routing in
   `graph.ts`'s `resolve()`: a block-type `SymbolRefNode` (`{kind:'symbolRef', symbolName:'FB',
   id:'PROT', portName:'ALARM'}`) now traverses the existing block-instantiation path, reusing the
   block instance via `blockMap.get('B#PROT')` and adding `ALARM` to its `usedPorts`. A previously
   uninstantiated block is created lazily with no inputs. This allows binding multiple outputs to
   one block without repeating its arguments — the Generic Block (FB) example was rewritten to
   demonstrate it: `TRIP = FB#PROT(PHASE=IA,...).TRIP` followed by `ALARM = FB#PROT.ALARM` and
   `CLOSE = FB#PROT.CLOSE` reuse the same block instance. Test coverage: 2 parser tests.

6. **NOT-only through-connection always shows a NOT gate by convention**, even under
   `OPTION INVERSION = BUBBLES`. **Done.** In `buildGraph`'s BUBBLES absorption pass, NOT gates whose
   source is an INPUT and whose only consumers are OUTPUT nodes are protected from absorption
   (added to `protectedNotIds`), so `O = NOT A` keeps the NOT symbol rather than collapsing to a
   lone output port bubble. Protection is scoped to single-inversion NOTs (depth 1) with an input
   source — `NOT (A AND B)` still uses the conventional gate-output bubble. Test coverage: layout
   suite updated to expect a NOT gate, with a comment referencing spec Tier 3.6.

7. **Rename `OPTION COMPACTNESS` → `SIZE`** (user-facing term for what it controls). **Done.**
   `resolveOptions` now accepts both `SIZE` and `COMPACTNESS` — `SIZE` is the canonical name,
   `COMPACTNESS` kept for back-compat. Identical semantics (named values + explicit `[v,h]`
   factors).

8. **Fix `OPTION GATE_INPUT_STYLE = BARS`** (was known-broken). **Done.** Two fixes: (a) the bar-tap
   port assignment now evenly distributes the 3rd+ inputs across the full gate body height (with a
   1-grid-cell inset top and bottom) instead of cramming them into 10px; (b) the nested fan-in
   channel allocator's `above` and `below` groups were both starting at
   `gate.absX - GATE_CLEARANCE` and overlapping — `below` now shifts by half a step leftward to
   interleave with `above`. Bar/stub constants match the spec (12px / 6px). BARS examples are now
   included in the universal layout invariants (the prior exclusion is removed); both Input Bars and
   Combined Options pass all 13 invariants.

### Tier 4 — Output structure, theming, export — **RESOLVED (2026-06).**

9. **Semantic, usable SVG structure.** **Done.** The SVG output is partitioned into layered groups:
   `<g class="ldl-layer-wires">`, `ldl-layer-bodies`, `ldl-layer-ports`, `ldl-layer-dots`,
   `ldl-layer-objects`, `ldl-layer-labels`. Each logical object carries a stable `id`:
   gates/blocks by their user-facing `#ID` (or internal id), inputs/outputs by their name,
   wires by `wire_{i}`, junctions by `dot_{i}`, net labels by `netlabel_{i}`. The internal id
   is also exposed via `data-ldl-id` for tooling. CSS `#ID` selectors in STYLE blocks target
   the user-facing identifier.

10. **Theming.** **Done.** `STYLE ... END STYLE` blocks are extracted as raw CSS (the tokenizer
    detects STYLE blocks and skips the CSS body, which contains characters the LDL lexer can't
    handle: `#`, `{`, `}`, `:`, `;`). The CSS is injected into the rendered SVG's `<defs><style>`,
    so `#G1 { stroke: red; }` restyles the SVG group whose `id` is `G1`. `OPTION STROKE_WIDTH`
    sets a global stroke-width knob applied via CSS to every symbol body, bubble, and input bar.
    External `STYLESHEET` loading is accepted by the parser but not resolved (requires a file
    system resolver; future work).

11. **Options to hide junction dots.** **Done.** `OPTION HIDE_JUNCTIONS = TRUE|FALSE` sets
    `opts.hideJunctions`; the SVG root carries `ldl-hide-dots` class and a CSS rule hides
    `.ldl-junction-group`. The viewer toolbar has a "Dots" toggle that flips the same option on
    top of the source-driven setting.

12. **Click to reveal gate/object IDs.** **Done.** The viewer has a click handler that walks up
    the DOM from the click target to find the first element with an `id`, then surfaces it in a
    small popup at the click location with a "Copy" button (clipboard write). Works on gates,
    blocks, inputs, outputs, wires, junction dots, and net labels.

13. **PNG export with selectable resolution.** **Done.** The viewer toolbar has a PNG dropdown
    with 1x/2x/3x/4x scale options. The export reuses the SVG-to-canvas pipeline (same as PDF)
    but writes the PNG directly via `canvas.toBlob` instead of going through jsPDF.

## Current Issues

0. ~~**A\* router falls back to a diagonal straight line when it cannot route a wire
   orthogonally.**~~ **RESOLVED** — both fallbacks in `astar-router.ts` (the `orthogonalize`
   degenerate-path case and the final `solve() ?? solve() ?? …` when A\* fails in both the bounded
   region and the full canvas) returned a direct `[source, dest]` line, which is diagonal when the
   endpoints differ in both axes. Replaced with `orthFallback()` — a straight line when they share
   a Y, otherwise a clean Z (exit and enter horizontally). Guarded by `tests/unit/router-fallback.spec.ts`
   (asserts zero diagonal segments across every example plus a cross-connected stress case). The
   stress case that exposed it now routes fully orthogonally with no gate-body crossings.

1. ~~In the demo, if example goes past the screen the example selector at the top gets lost. The top bars should always stay at the top even if the text input is large or the diagram is large.~~ **RESOLVED** — root cause was `global.css` `ldl-app { display: block }` overriding the component's `:host { display: flex }`, so the column flex layout never constrained `.main` to the viewport; the toolbar stayed but the panes could grow past the screen. Fixed by making `ldl-app` `display: flex; flex-direction: column` in `global.css` and adding explicit `min-height: 0` to the flex panes.

2. ~~The fit is not fitting as well as it should, it is often smaller than it needs to be, see for example "Interlocking Q01 Close". When I click the button we need to fit the horizontal and vertical extents as much as possible within the current view.~~ **RESOLVED** — the SVG's `max-width:100%` meant `.viewer-content` never rendered at the diagram's pixel size, so the fit maths used the wrong dimensions. Now the viewer sizes the content box to the SVG `viewBox`, the wrapper gets `min-height/min-width:0` so it clips instead of growing, `handleFit` fits both extents (`min(scaleX, scaleY)`, centred), and new diagrams auto-fit on load.

3. ~~Boolean Algebra with "OPTION OUTPUT_ORDER = DECLARATION" not puts two of the outputs at the bottom. But if that's the case then the inputs should be re-ordered to allow it. Let's make the default be OPTION INPUT_ORDER = AUTO to fix this.~~ **RESOLVED** — added `OPTION INPUT_ORDER` (AUTO default = Sugiyama barycentre reordering, DECLARATION = keep declared order). The barycentre reordering was always on; it is now exposed and documented, with AUTO the default so input rows reorder to suit the chosen output order.

4. ~~Very large AND gates have the edges of the curved gate calculated wrong, see this example: X = A AND B AND C AND D AND E AND F AND G AND H AND I AND J AND K.~~ **RESOLVED** — `andGateBody` used arc radius `h/2`, so once `h > w` the top edge went to a negative X and the shape broke. The corner radius is now capped at `w/2`; the body is a rounded rectangle that degenerates to the classic semicircular "D" for short gates. The OR body scales with height and cannot produce invalid geometry.

5. ~~When a gate has many inputs the minimum gap between them is too small (it should be the same as the gap between the ports). This implies we should move the gate to the right. How can we include this in our general philosophy?~~ **RESOLVED** — added a nested fan-in channel pass: each dogleg wire into a gate gets its own vertical channel just left of the gate, spaced `FANIN_SPACING` (15px, = port gap) and nested (most extreme source turns nearest the gate) so the fan-in is never more crowded than the ports and never crosses. Placing the channels in the gap left of the gate achieves the consistent gap without physically moving the gate. Documented as "Multi-Input Fan-In Channels" in the spec.

6. ~~Also even for a trivial example, the gate routing at the bottom is not very good. Try this example: X = A OR B OR C OR D OR F OR G OR H OR I OR J OR K OR L OR M OR N OR O OR P. There are unnecessary doglegs and crossovers and its not symmetrical with the top but it should be.~~ **RESOLVED** — the nested fan-in (see issue 5) nests above- and below-side inputs independently and symmetrically, eliminating the bottom-side doglegs/crossovers for large OR (and AND) gates.

7. ~~There should be an output indicating if the checks have passed which is displayed on the left below the console input (all gates orthogonal / minimum gaps met / all inputs and outputs and gates connected / no crossovers or unable to solve).~~ **RESOLVED** — `src/renderer/checks.ts` `validateLayout()` runs the four checks over the `LayoutResult`; `ldl-app` shows a colour-coded ✓/✗ panel below the editor (with detail on failures). Surfacing the checks also caught a real 10px port-gap on Boolean Algebra's AND, now fixed (the dogleg-killer prefers a whole-gate shift over nudging one port).

8. ~~PDF output is truncated on the right. Some of the output ports are not visible.~~ **RESOLVED** — port label text could extend past the node bounding boxes, but the viewBox was sized from `layout.width` only. `renderDiagram` now measures label extents (plain + math) and sizes the viewBox/translate to the true content bounds (left for input labels, right for output labels), with a safety margin for the semi-bold name weight. PDF uses the same render path so it is fixed too.

9. ~~Where possible multiple tap-offs (if they are close enough) should use the same dot...~~ **RESOLVED** — two complementary passes: (a) same-source sibling branches whose vertical channels are within `FANIN_SPACING` snap to a single shared trunk X (validated against other nets), and (b) junction dots within 8px are merged into one. Boolean Algebra's node A now shows a single tap dot instead of two.

10. **On Boolean Algebra we need to think about laying out of gates** (a NOT placed above pushes other output gates around and adds bends; if it went the other way the others would be straight). **Status: analysed, proposal below — not yet implemented** (deferred deliberately: gate placement ripples across every example and the issue asks to "consider and discuss").

   **Current approach.** Rows are assigned by a one-directional Sugiyama barycentre: input rows are ordered by the average row of their *consumers* (downward), then each gate is placed at the midpoint `(minRow+maxRow)/2` of its *inputs* (upward). A gate's position therefore ignores where its own output goes, so a gate can sit at a row that forces its output wire (and the gates it pushes aside) to bend.

   **Proposed improvement.** Make placement bidirectional and bend-aware:
   - Alternate upward (place by inputs) and downward (place by consumers) barycentre sweeps for *gates*, not just inputs, so a gate gravitates to a row that lines up with both its sources and its sink — fewer doglegs on the output side.
   - Within a depth column, break ordering ties by the total wire-bend cost (count of doglegs the ordering implies), choosing the orientation (e.g. a 1-input NOT going down vs up) that keeps the most wires straight.
   - Keep it guarded by the invariants suite + visual spot-checks, since column re-ordering affects every example.

   This is a self-contained follow-up; the routing-quality work in issues 1–9 is independent of it.

   **Instrumentation (2026-06).** Before changing placement, two guards are now in place so the
   change is safe and measurable: a **geometry snapshot** (`visual-regression.spec.ts`) that makes
   any layout change a reviewable diff, and a **bend/crossing metric** (`bend-metrics.spec.ts`)
   that quantifies placement quality per example (baseline hotspots: Complex Protection (SEL)
   16 bent/10 crossings, Combined Options 7 crossings, Interlocking 12 bent, Boolean Algebra
   5 bent/1 crossing). The bend-aware sweep change should reduce these without raising any
   example's counts. The placement algorithm change itself is the remaining work.

   **Attempts (2026-06, measured + reverted).** Two levers were tried against the instruments
   and both *traded* defects rather than improving net — confirming the placement, alignment and
   routing passes are tightly coupled:
   - **Bidirectional ordering** (order each column by median row of inputs *and* consumers): near-
     neutral metrics (bent 124→121, crossings 31→**32**) and broke 2 invariants on Complex
     Protection (SEL) — a real 15px dogleg into an AND and a 10px cross-net horizontal overlap at
     y=920. Visually it cleanly *groups* the OC-trip chain (a genuine plus) but adds a large empty
     vertical band and the overlap. A trade, not a win.
   - **Per-wire fan-in fallback** (reshape each fan-in wire into the first free valid channel
     instead of the all-or-nothing group reshape): *fixed* the bidirectional dogleg (root cause:
     two inputs landing on ports 15px apart, one wire overshooting to the other's Y), broke no
     default invariants, but **regressed default crossings 31→35** and the bidirectional overlap
     remained. The all-or-nothing fan-in is conservative on purpose; relaxing it trades crossings.

   - **Per-wire fan-in "rescue" fallback** (strict crossing-safe channel, only rescue wires with a
     sub-MIN_DOGLEG jog): left default layouts byte-identical (zero regression), but **did not fix
     the bidirectional defects** either.

   **Root cause (definitive).** Instrumenting the failing wire (`in_17 → and_18` under
   bidirectional ordering on Complex Protection (SEL)) showed `channelOk` rejects its clean
   channel via `hGateClear` — the **`FALLING` block `falling_24` sits at y875 directly in the
   wire's straight path**. The bidirectional ordering placed a gate body *in another wire's path*.
   Routing around it forces a sub-MIN jog because the block body (855–895) overlaps the target
   input port's level (905). This is a **placement** problem, not a routing/alignment one: no
   fan-in or alignment change can straighten a wire whose path is physically blocked by a gate the
   ordering put there.

   Conclusion: making bidirectional ordering viable needs **obstacle-aware placement** (don't drop
   a gate into a wire's lane).

   **Obstacle-aware placement — LANDED (2026-06).** Implemented the Sugiyama long-edge technique:
   every edge spanning more than one depth column is decomposed into a chain of thin `DUMMY` nodes
   (one per intermediate column) that **reserve a vertical lane** during coordinate assignment, so
   a real gate is never placed in a wire's straight path. Key details that made it a clean win
   (not the earlier regressions):
   - The **ordering (rowMap) is computed on real nodes only** — dummies don't reorder gates; each
     dummy is slotted at the row *interpolated* between the edge's endpoints (on the wire's line).
     This avoids the gate-reordering that regressed default layouts in the first attempt.
   - Dummies have height 0 (the lane spacing comes from `VGAP`) and are **removed after placement**
     — geometry and routing see only real nodes, now placed clear of the lanes; routing uses the
     original edges through the cleared lane.
   - A conservative **jog-straightening pass** collapses any gratuitous sub-`MIN_DOGLEG` vertical
     step the new spacing leaves when the span is gate-clear (only interior jogs, never a terminal
     port).

   Result across all 24 examples (vs the previous default): **crossings 31 → 28, bent wires
   124 → 122, doglegs 0 → 0, all invariants pass**; total height +105px (~4px/example). Complex
   Protection (SEL), Interlocking, Boolean Algebra and the rest are visibly cleaner (gates get
   breathing room, fewer mid-column crossings). Guarded by the geometry snapshot + bend metric.
   This is now the default placement; the bidirectional-ordering experiment is no longer needed.

   **Progress (2026-06).** The target is now specified — see "Visual Quality Objectives" and
   "Coordinate Assignment (Two-Sided Alignment)" in `spec/sections/layout-rules.adoc`.
   Delivered so far:
   - **Output placement via `OUTPUT_ORDER = AUTO`** — the practical lever for the user-visible
     problem. Outputs reorder by source-gate Y so each output wire is straight instead of a
     long vertical (big improvement on Complex Protection / Overcurrent, which now enable it).
     Kept opt-in (not the global default) because AUTO still regresses *Inversion Bubbles*:
     two outputs land on the same congested track and one wire gets a 5px jog that can't be
     straightened without overlapping another net. Making AUTO the global default is gated on
     fixing that routing congestion.
   - **`OPTION COMPACTNESS`** (NORMAL / COMPACT_V / COMPACT_H / COMPACT / SPACIOUS) — scales
     row spacing (vertical) and/or column spacing (horizontal) so a diagram can be denser or
     airier on either axis; the collision/protected-zone passes still enforce minimum gaps so
     it never overlaps.
   - A two-sided gate-alignment pass (nudge each gate to the median Y of its sources *and*
     consumers) was prototyped but **reverted**: it passed all invariants yet its aesthetic
     results were mixed (it reordered gates and added a bend on Boolean Algebra's A+B).
   - A **full priority-method coordinate assignment** (Sugiyama/Tagawa: fixed per-column
     order, alternating up/down sweeps, degree priority, port-aligned down-target) is now the
     **landed** vertical-placement method (`assignCoordinates` in `layout.ts`), replacing the
     old global row-rank mapping. Each node's centre is aligned to the median of its
     neighbours on both sides; the loop ends on the down-sweep so a gate stays near the inputs
     it fans in from (short, clean fan-in) while still picking up consumer influence. Result:
     Complex Protection is compact with every output wire straight; Interlocking / Mixed /
     Differential stay clean; all 283 invariants pass.
   - Landing it required two supporting changes: (a) the **fan-in pass now reshapes *every*
     incoming dogleg wire** into a clean nested channel (not just the ones A\* happened to
     leave as 4-point), so congested multi-input gates get straight nested fan-in; and (b) the
     clean-Z router fast path searches the **whole source→dest span** for a free channel, so
     many wires fanning into one gate each find a distinct channel without an expensive grid
     search. Timing stays in budget: trivial/medium 1–2 ms, a 60-node tree ~200 ms, the
     pathological 92-node single-30-input-OR ~0.9 s.

11. **Robustness fuzz (2026-06): correctness solid, two soft-quality gaps.** Ran a 44-case corpus
    (`tests/unit/robustness.spec.ts` — simple gates, deep/wide trees, fan-out DAGs, feedback, every
    block type, generic FB, labels, all options, pathological cases). **Every case passes the
    correctness invariants**: no diagonal segments, no wire through a gate body, full connectivity,
    no overlapping gate bodies. Two soft-quality gaps remain (not asserted; tracked here):

    - ~~**Large fan-in gates (≈20+ inputs) cram their taps and tangle.**~~ **RESOLVED** — the
      nested fan-in used a fixed 15px channel step, so a many-input gate ran its deep channels off
      the left edge; they clamped onto the same X, the all-or-nothing reshape failed, and the wires
      stayed as crossing-heavy raw routes (30-input OR ≈ 138 crossings). The channel step is now
      **adaptive** (tightened to fit the room left of the gate), so AND/OR fan-ins of 20 and 30
      inputs nest cleanly with **zero crossings**. Realistic gates (≤~8 inputs) keep the 15px step
      unchanged (no example geometry changes).
    - **Sub-`MIN_DOGLEG` jogs — mostly fixed.** The seal-in latch `NOT → AND` 15px jog is
      **RESOLVED** (the residual dogleg pass was pairing the feedback port — which has no left-hand
      source — to a real source by sorted index and shifting the whole gate; feedback ports are now
      excluded). **All 24 built-in examples now have zero doglegs.** Two residual jogs remain *only
      in synthetic stress cases*, both deep placement-coupling: (a) an edge-block output → output
      node where the long-edge lane reserved for it is offset by a competing gate at the same depth
      (the lane-vs-gate priority tension), and (b) an input into a wide OR whose curve-tap Y differs
      from the fan-in channel Y. Both are ≤25px and cosmetic; fixing them safely needs the deeper
      placement rework (lane priority / curve-tap-aware fan-in) rather than a local patch.

# Authoring LDL — a guide for AI agents

This is a **self-contained, implemented-only** reference for generating LDL (Logic Diagram Language)
source. Prefer it over the full [spec](../spec/spec.adoc): the spec is a formal grammar that also
describes *reserved but not-yet-implemented* features. Everything below renders today.

Give an end user a diagram by emitting an LDL file and rendering it with
`@openpowershift/logic-diagram-language` (`parse` → `renderDiagram`, see [api.adoc](api.adoc)).

## Mental model

- An LDL file is a list of **assignments** `NAME = <expression>`. The renderer lays everything out
  automatically — you never specify coordinates.
- A name **consumed** in another expression becomes a shared internal signal (it fans out). A name
  **not** consumed anywhere becomes a diagram **output** (drawn on the right). Boundary names that are
  only ever *read* become **inputs** (drawn on the left).
- So: to make `X` an output, don't reference it elsewhere. To force an intermediate to also render as
  an output, add `X.OUT = TRUE`.

## Core syntax (all implemented)

```ldl
// comment to end of line

O1 = A AND B OR NOT C          // operators: AND, OR, NOT  (precedence: NOT > AND > OR)
O2 = A AND (B OR C)            // parentheses group
INT = A AND B                  // INT is consumed below -> internal signal (not an output)
O3 = INT OR D

// Labels & descriptions (identifiers stay the machine name; labels are display text)
A.Name = "Overcurrent"
A.Description = "50P1 pickup"
O1.Name = "Trip"

// Inline TeX math in any label (input/output, gate, function-block, or net) with $...$
IA.Name = "$I_a > I_{pickup}$"
// IMPORTANT: string literals are raw except for \" — TeX commands take a SINGLE backslash.
// Write "$\frac{a}{b}$", NOT "$\\frac{a}{b}$" (a doubled \\ is a TeX line break and mis-renders).

// Force an internal signal to ALSO be drawn as an output
INT.OUT = TRUE
```

### Operators

Only **`AND`**, **`OR`**, **`NOT`** exist. `NAND`, `NOR`, `XOR`, `XNOR` are **not implemented** —
express them the long way (e.g. NAND → `NOT (A AND B)`).

### Named gates

Give a specific gate an id (so it can be labelled or CSS-styled) with `GATE#ID(...)`:

```ldl
TRIP = AND#G1(A, B, C)
G1.Name = "Trip AND"
```

### Function blocks (SEL-style)

```ldl
T   = TIMER(IN, 2cyc, 5cyc)      // TIMER(input, pickup, dropout); durations: 2cyc, 30cyc, 3s, 0
L   = SR(SET, RESET)             // SR latch (default output Q). For the inverted output: SR(SET, RESET).NQ
E   = RISING(A)                  // rising-edge  (FALLING(A) for falling)
C   = COMPARE(IA, IPICKUP)       // comparator: + over -, outputs true when IA > IPICKUP
// Generic block with named ports and a selected output port:
P50 = FB#E50P1(I = IPH, TC = NOT BLK).T
E50P1.Name = "50P1"
E50P1.Description = "DT 4.8 x In, 0.02 s"
```

- Reference a block's output port with `.PORT` (e.g. `.Q`, `.NQ`, `.T`). Default port if omitted.
- Reuse a block instance by id: `SR#L1(...)` used twice refers to the same latch.

### Feedback / seal-in

If a name appears **inside its own definition**, that reference is drawn as a loop-back wire (a latch
holding itself in) rather than a new input:

```ldl
SEAL = (PICKUP OR SEAL) AND NOT RESET   // SEAL feeds back into itself
```

### Options

Put `OPTION` lines at the top. Implemented options and defaults:

| Option | Values (default first) |
| --- | --- |
| `INVERSION` | `GATES`, `BUBBLES` |
| `PORT_STYLE` | `CIRCLE`, `SQUARE`, `NONE` (hide terminal dots; keep only junction/crossover dots) |
| `GATE_INPUT_STYLE` | `EXPAND`, `BARS` |
| `LABEL_STYLE` | `BELOW` (default), `SIDE` (block/gate description beside the body, not in the channel below) |
| `INPUT_ORDER` | `AUTO`, `DECLARATION` |
| `OUTPUT_ORDER` | `AUTO`, `DECLARATION` |
| `COLUMN_SPACING` | `ADAPTIVE`, `UNIFORM` |
| `COMPACTNESS` | `NORMAL`, `COMPACT_V`, `COMPACT_H`, `COMPACT`, `SPACIOUS`, or `70,70` |
| `MARGIN` | integer px (default `8`) |
| `WIRE_LABEL_LEADER` | `TRUE` (default), `FALSE` |
| `STROKE_WIDTH` | number px (default `2.5`) |
| `HIDE_JUNCTIONS` | `TRUE`, `FALSE` |
| `FANOUT_CONNECTORS` | `TRUE`, `FALSE` (default) — draw a very-high-fan-out net as off-page connector tags instead of one crossing wire; kept only where it reduces crossings |

```ldl
OPTION INVERSION = BUBBLES
OPTION MARGIN = 16
```

### Styling (optional)

```ldl
STYLE
  #G1 path { fill: #ffecec; }              // a gate body by its id (target the shape, e.g. path/rect)
  .ldl-wire[data-to="TRIP"] { stroke: #c62828; stroke-width: 4; }
END STYLE
```

## Do NOT use (reserved but not implemented — they will not render)

`NAND` / `NOR` / `XOR` / `XNOR` operators · `CONNECT` · custom `SYMBOL` definitions ·
`IMPORT` / `STYLESHEET` · hyperlinks / `.LINK` · `.Style` attribute · `BIDI`.

## Complete worked examples

Simple trip logic:

```ldl
I1.Name = "Overcurrent"
I2.Name = "Block"
O1.Name = "Trip"
O1 = I1 AND NOT I2
```

Overcurrent with seal-in latch and a trip timer (SEL-style):

```ldl
OPTION INVERSION = BUBBLES

A    = SR#L1(COMPARE(IA, IPICKUP), RESET)   // comparator pickup into a seal-in latch (Q output)
TRIP = TIMER(A, 0, 30cyc)                   // 30-cycle trip delay; TRIP is unconsumed -> an output

IA.Name      = "$I_a$"
IPICKUP.Name = "$I_{pickup}$"
RESET.Name   = "Reset"
TRIP.Name    = "Trip"
```

Two protection elements ORed to a common trip, one shared blocking signal:

```ldl
BLK  = HBL2T AND WIN                  // shared internal signal (fans out to both)
P50  = FB#E50P1(I = IPH, TC = NOT BLK).T
Q50  = FB#E50Q1(I = IQ,  TC = NOT BLK).T
TRIP = P50 OR Q50

BLK.Name   = "Inrush block"
E50P1.Name = "50P1"
E50Q1.Name = "50Q1"
TRIP.Name  = "Trip"
```

## Checklist before returning a file

1. Only `AND` / `OR` / `NOT` operators (rewrite any NAND/NOR/XOR/XNOR).
2. `OPTION` lines first, then assignments.
3. Every signal that should be an **output** is not referenced elsewhere (or has `.OUT = TRUE`).
4. Labels via `.Name` / `.Description`; wrap math in `$...$` using **single** backslashes (`\frac`, not `\\frac`).
5. Validate by rendering: `parse(src).errors` must be empty.

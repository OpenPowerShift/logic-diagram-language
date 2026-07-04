# LDL — Logic Diagram Language

LDL is a small text language and renderer for **logic and protection schematics**. You
write boolean equations; the renderer draws the gates, routes the wires, and lays the
whole diagram out automatically — producing clean, publication-quality SVG (and PDF).

```
TRIP = OVERCURRENT AND NOT BLOCK
      OR (EARTH AND MANUAL)
```

That single expression yields a complete diagram: boundary inputs on the left, gates in
the middle, the `TRIP` output on the right, with wires routed and crossings minimised —
no coordinates, no manual placement.

## Why

Protection and control schematics are tedious to draw by hand and awkward to keep in
sync with the logic they represent. LDL treats the **logic as the source of truth**: the
diagram is a rendering of an expression, so it is diffable, reviewable, and regenerated
automatically whenever the logic changes.

## Goals & concepts

- **Expression-first.** A simple boolean expression produces a complete diagram. Names
  that are consumed elsewhere become shared internal signals; names that aren't become
  outputs.
- **Declarative — the layout is the renderer's job.** You describe *what* is connected,
  not *where* things go. A Sugiyama-style layout engine assigns layers and coordinates
  and actively minimises wire crossings; every reshaping pass validates a single
  wire-separation contract so wires never overlap or crowd.
- **Protection-domain aware.** Beyond `AND`/`OR`/`NOT`, LDL has SEL-style function
  blocks — `TIMER`, `SR` latch, `RISING`/`FALLING` edge triggers, `COMPARE` comparator,
  and a generic `FB` block — plus seal-in/feedback loops drawn as loop-back wires.
- **Labelled & styled.** Inputs, outputs and gates carry `.Name`/`.Description` labels
  (with inline TeX math via MathJax), and every element has a stable id/class for CSS.
- **Readable output.** Options control inversion bubbles vs. NOT gates, input bars,
  compactness, adaptive column spacing, and more.

## Quick start

Requires Node 24+ (see `.nvmrc`).

```bash
npm install
npm run dev        # live playground at the printed URL — type LDL, see SVG update live
npm run build      # type-check + production build to dist/
npm test           # run the test suite (vitest)
```

The playground has a source editor on the left and a live diagram on the right, with a
dropdown of built-in examples covering every language feature. Toggle labels/ids,
junction dots, zoom, and export to SVG/PDF.

## A taste of the language

```ldl
OPTION OUTPUT_ORDER = AUTO

// SEL-style: a comparator feeds an SR latch, sealed in, into a pickup timer
A     = SR(COMPARE(IA, IPICKUP), RESET)
TRIP  = TIMER(A, 0, 30cyc)
ALARM = RISING(COMPARE(IA, IPICKUP))

IA.Name       = "$I_a$"
IPICKUP.Name  = "$I_{pickup}$"
TRIP.Name     = "Trip"
```

See the **[User Guide](docs/user-guide.adoc)** for the full working syntax with
examples, and the **[LDL Specification](spec/spec.adoc)** for the formal grammar and the
rendering contract. Current implementation status is tracked in
[IMPLEMENTATION.md](IMPLEMENTATION.md).

## Project layout

| Path | What |
| --- | --- |
| `src/parser/` | Tokeniser, parser, and AST for LDL source |
| `src/renderer/` | Layout engine (`layout.ts`, `graph.ts`), A\* wire router, SVG renderer, gate symbols |
| `src/components/` | Lit web components — the playground app, editor and viewer |
| `src/worker/` | Off-thread parse → layout → render worker |
| `docs/` | User guide |
| `spec/` | AsciiDoc language specification (`spec/spec.adoc`) |
| `tests/` | Vitest unit tests, layout invariants, and golden geometry/visual-regression snapshots |

## Status

LDL is under active development. The core language (boolean expressions, intermediates,
feedback, SEL function blocks, labels, TeX math, styling, and the layout options) is
implemented and tested. Some specified constructs are reserved but not yet implemented —
the `NAND`/`NOR`/`XOR`/`XNOR` operators, `CONNECT`, custom `SYMBOL` definitions,
`IMPORT`/`STYLESHEET`, and hyperlinks. See the guide and `IMPLEMENTATION.md` for the
current boundary.

## License

[MIT](LICENSE) © 2026 Daniel Mulholland

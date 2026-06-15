# Implementation Status

Spec version: 0.3.0-draft
Last updated: 2026-06-15

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
| `OPTION GATE_INPUT_STYLE` | Done | EXPAND (default) and BARS |
| `OPTION LABEL_STYLE` | Missing | Only SIDE behavior exists; ABOVE_BELOW not implemented |
| `CONNECT` explicit wires | Missing | Parser stores `ConnectDecl[]` but renderer never reads them |
| `STYLE ... END STYLE` | Partial | Parser stores blocks in `StyleDecl[]` but renderer never embeds CSS |
| `STYLESHEET` loading | Missing | Parser accepts but discards |
| `SYMBOL ... END SYMBOL` definitions | Missing | Parser skips block |
| `IMPORT TEMPLATE` | Missing | Parser discards data |
| Hyperlinks (`.LINK`) | Missing | Not parsed or rendered |
| Port-level style overrides | Missing | `styleMap` built in layout but never assigned to `LayoutPort.style` |

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
| Wire routing | Done | Obstacle-aware with doglegs |
| Inversion bubbles | Done | Input-side and output-side |
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
| Layout rule compliance tests | Done | 70 tests across all examples |
| Math renderer tests | Done | 10 tests |
| Visual (Playwright) tests | Done | |

// Public library API for @openpowershift/logic-diagram-language.
//
// Pipeline:  LDL source ── parse ──▶ Diagram ── layoutDiagram ──▶ LayoutResult
//                                         └──── renderDiagram ──▶ SVG string
//
// renderDiagram runs the layout internally, so the common path is just parse → renderDiagram.
// SVG rendering is isomorphic (works in Node and the browser). The optional PNG/PDF helpers in
// ./export-image are browser-only (they rasterise the SVG through a <canvas>).

export { parse } from './parser/index.js';
export { renderDiagram } from './renderer/svg-renderer.js';
export { layoutDiagram, findWireCrossings } from './renderer/layout.js';
export { resolveOptions, DEFAULT_OPTIONS } from './parser/ast.js';

// Options + parsed-model types.
export type {
  RenderOptions, InversionStyle, PortStyle, GateInputStyle, OutputOrder, InputOrder,
  Compactness, ColumnSpacing,
  Diagram, DiagramOutput, GateType, LogicNode, PortNode, GateNode, SymbolRefNode, BlockNode,
  BlockType, PortMeta, ObjectDecl, AttributeDecl, ConnectDecl, StyleDecl, OptionDecl,
  ParseResult, ParseError, Position,
} from './parser/ast.js';

// Geometry (layout) types — for consumers that post-process the layout instead of the SVG.
export type {
  LayoutResult, LayoutNode, LayoutPort, LayoutWire, LayoutJunction, LayoutLabel, WireCrossing,
} from './renderer/layout.js';

// Themes.
export { LIGHT_DIAGRAM, DARK_DIAGRAM } from './theme/themes.js';
export type { DiagramTheme } from './theme/themes.js';

// Ready-made example sources (a map of name → LDL source) used by the playground and docs.
export { EXAMPLES, EXAMPLE_NAMES } from './examples.js';

// Browser-only raster/PDF export helpers (rasterise an SVG string via <canvas>).
export { svgToPngBlob, svgToPdfBlob } from './export-image.js';

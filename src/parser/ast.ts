export type GateType = 'AND' | 'OR' | 'NOT' | 'NAND' | 'NOR' | 'XOR' | 'XNOR';

export type InversionStyle = 'GATES' | 'BUBBLES';
export type PortStyle = 'CIRCLE' | 'SQUARE';
export type GateInputStyle = 'EXPAND' | 'BARS';
export type OutputOrder = 'DECLARATION' | 'AUTO';
export type InputOrder = 'DECLARATION' | 'AUTO';
// COMPACT_V tightens vertical (row) spacing, COMPACT_H tightens horizontal (column) spacing,
// COMPACT does both. NORMAL is the default; SPACIOUS loosens vertical spacing.
export type Compactness = 'COMPACT' | 'COMPACT_H' | 'COMPACT_V' | 'NORMAL' | 'SPACIOUS';
// UNIFORM (default) = fixed column pitch. ADAPTIVE = each inter-column gap sized to what its gates
// actually need, so simple columns pack tighter and the diagram is narrower. Opt-in, per diagram.
export type ColumnSpacing = 'UNIFORM' | 'ADAPTIVE';

export interface RenderOptions {
  inversion: InversionStyle;
  portStyle: PortStyle;
  gateInputStyle: GateInputStyle;
  outputOrder: OutputOrder;
  inputOrder: InputOrder;
  compactness: Compactness;
  // Optional explicit spacing factors [vertical, horizontal] (e.g. COMPACTNESS = 70,70 → both
  // axes at 70%). When set, these override the named `compactness` value.
  compactnessFactors?: [number, number];
  // Column pitch mode. UNIFORM (default) keeps the fixed COL_SPACING pitch; ADAPTIVE sizes each
  // inter-column gap to its content (OPTION COLUMN_SPACING = ADAPTIVE).
  columnSpacing: ColumnSpacing;
  // Blank margin (px) around the diagram content in the rendered/exported SVG. Default 8.
  // Set via OPTION MARGIN = <px>.
  margin: number;
  // Tier 4.10/11 — new options.
  // Stroke width for wires + gate bodies (px, default 2.5). Set via OPTION STROKE_WIDTH.
  strokeWidth?: number;
  // Hide all junction dots (Item 11). Set via OPTION HIDE_JUNCTIONS = TRUE | FALSE.
  hideJunctions: boolean;
}

export const DEFAULT_OPTIONS: RenderOptions = {
  inversion: 'GATES',
  portStyle: 'CIRCLE',
  gateInputStyle: 'EXPAND',
  // AUTO input/output ordering and ADAPTIVE column spacing are the defaults: they minimise wire
  // crossings and pack columns to their content (narrower diagrams) with no downside on the corpus.
  // Set the DECLARATION / UNIFORM values explicitly per diagram to opt back out.
  outputOrder: 'AUTO',
  inputOrder: 'AUTO',
  compactness: 'NORMAL',
  columnSpacing: 'ADAPTIVE',
  margin: 8,
  hideJunctions: false,
};

export interface Position {
  line: number;
  column: number;
  offset: number;
}

export interface PortNode {
  kind: 'port';
  name: string;
  pos?: Position;
}

export interface GateNode {
  kind: 'gate';
  gateType: GateType;
  id?: string;
  inputs: LogicNode[];
  pos?: Position;
}

export interface SymbolRefNode {
  kind: 'symbolRef';
  symbolName: string;
  id?: string;
  portName?: string;
  pos?: Position;
}

export type BlockType = 'TIMER' | 'SR' | 'RISING' | 'FALLING' | 'COMPARE' | 'FB';

// SEL-style function block, e.g. TIMER(IN, 2cyc, 5cyc) or SR#L1(SET, RESET).NQ.
// FB is a generic user block: inputs from the call args (optionally labelled NAME=expr),
// outputs from the .port selectors referenced, with a name/description.
export interface BlockNode {
  kind: 'block';
  blockType: BlockType;
  id?: string;                    // explicit instance id (from BLOCK#id)
  inputs: LogicNode[];            // signal inputs
  inputLabels?: (string | undefined)[]; // per-input port label (FB named inputs)
  params: Record<string, string>; // settings: PU, DO, DOMINANT, ...
  port?: string;                  // output port selector (e.g. Q, NQ)
  pos?: Position;
}

export type LogicNode = PortNode | GateNode | SymbolRefNode | BlockNode;

export interface DiagramOutput {
  name: string;
  expression: LogicNode;
  pos?: Position;
}

export interface ObjectDecl {
  symbolName: string;
  id?: string;
  pos?: Position;
}

export interface PortMeta {
  identifier: string;
  property: 'Name' | 'Description' | 'Style' | 'Out';
  value: string;
  pos?: Position;
}

export interface AttributeDecl {
  objectRef: string;
  id?: string;
  attributeName: string;
  value: string;
  pos?: Position;
}

export interface ConnectDecl {
  fromObject: string;
  fromId?: string;
  fromPort: string;
  toObject: string;
  toId?: string;
  toPort: string;
}

export interface StyleDecl {
  css: string;
}

export interface OptionDecl {
  name: string;
  value: string;
  pos?: Position;
}

export interface Diagram {
  outputs: DiagramOutput[];
  objects: ObjectDecl[];
  portMeta: PortMeta[];
  attributes: AttributeDecl[];
  connections: ConnectDecl[];
  styles: StyleDecl[];
  options: OptionDecl[];
}

export interface ParseError {
  message: string;
  line: number;
  column: number;
  offset: number;
}

export interface ParseResult {
  diagram: Diagram;
  errors: ParseError[];
}

export function resolveOptions(optionDecls: OptionDecl[]): RenderOptions {
  const opts: RenderOptions = { ...DEFAULT_OPTIONS };
  for (const decl of optionDecls) {
    const name = decl.name.toUpperCase();
    const value = decl.value.toUpperCase();
    if (name === 'INVERSION' && (value === 'GATES' || value === 'BUBBLES')) {
      opts.inversion = value;
    } else if (name === 'PORT_STYLE' && (value === 'CIRCLE' || value === 'SQUARE')) {
      opts.portStyle = value;
    } else if (name === 'GATE_INPUT_STYLE' && (value === 'EXPAND' || value === 'BARS')) {
      opts.gateInputStyle = value;
    } else if (name === 'OUTPUT_ORDER' && (value === 'DECLARATION' || value === 'AUTO')) {
      opts.outputOrder = value;
    } else if (name === 'INPUT_ORDER' && (value === 'DECLARATION' || value === 'AUTO')) {
      opts.inputOrder = value;
    } else if (name === 'MARGIN') {
      const m = parseFloat(decl.value);
      if (!isNaN(m) && m >= 0) opts.margin = m;
    } else if (name === 'STROKE_WIDTH') {
      const w = parseFloat(decl.value);
      if (!isNaN(w) && w > 0) opts.strokeWidth = w;
    } else if (name === 'HIDE_JUNCTIONS') {
      if (/^(true|1|yes|on)$/i.test(value)) opts.hideJunctions = true;
      else if (/^(false|0|no|off)$/i.test(value)) opts.hideJunctions = false;
    } else if (name === 'COLUMN_SPACING' && (value === 'UNIFORM' || value === 'ADAPTIVE')) {
      opts.columnSpacing = value;
    } else if (name === 'SIZE' || name === 'COMPACTNESS') {
      if (value === 'COMPACT' || value === 'COMPACT_H' || value === 'COMPACT_V' ||
          value === 'NORMAL' || value === 'SPACIOUS') {
        opts.compactness = value;
        opts.compactnessFactors = undefined;
      } else {
        // Explicit factors, e.g. `COMPACTNESS = 70,70` (vertical, horizontal). A value > 3 is
        // read as a percentage (70 -> 0.70); a value <= 3 is taken as a raw factor (0.7).
        const nums = value.replace(/[[\]\s]/g, '').split(',').map(s => parseFloat(s)).filter(n => !isNaN(n) && n > 0);
        if (nums.length >= 1) {
          const f = (n: number) => (n > 3 ? n / 100 : n);
          opts.compactnessFactors = [f(nums[0]), f(nums.length >= 2 ? nums[1] : nums[0])];
        }
      }
    }
  }
  return opts;
}
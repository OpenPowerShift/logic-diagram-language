export type GateType = 'AND' | 'OR' | 'NOT' | 'NAND' | 'NOR' | 'XOR' | 'XNOR';

export type InversionStyle = 'GATES' | 'BUBBLES';
export type PortStyle = 'CIRCLE' | 'SQUARE';
export type GateInputStyle = 'EXPAND' | 'BARS';
export type OutputOrder = 'DECLARATION' | 'AUTO';
export type InputOrder = 'DECLARATION' | 'AUTO';

export interface RenderOptions {
  inversion: InversionStyle;
  portStyle: PortStyle;
  gateInputStyle: GateInputStyle;
  outputOrder: OutputOrder;
  inputOrder: InputOrder;
}

export const DEFAULT_OPTIONS: RenderOptions = {
  inversion: 'GATES',
  portStyle: 'CIRCLE',
  gateInputStyle: 'EXPAND',
  outputOrder: 'DECLARATION',
  inputOrder: 'AUTO',
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

export type LogicNode = PortNode | GateNode | SymbolRefNode;

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
  property: 'Name' | 'Description' | 'Style';
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
    }
  }
  return opts;
}
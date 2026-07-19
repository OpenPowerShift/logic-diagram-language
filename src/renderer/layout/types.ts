// Layout geometry types and shared layout constants. No behaviour — pure data + numbers — so every
// other layout/* module can depend on this without cycles.
import type { RenderOptions } from '../../parser/ast.js';

export interface LayoutPort {
  name: string;
  absX: number;
  absY: number;
  bubbled?: boolean;
  bubbledOutput?: boolean;
  style?: 'CIRCLE' | 'SQUARE';
  label?: string; // visible port label inside the body (generic FB blocks)
}

export interface LayoutNode {
  id: string;
  gateType: string;
  label?: string;
  name?: string;
  description?: string;
  absX: number;
  absY: number;
  width: number;
  height: number;
  inputs: LayoutPort[];
  outputs: LayoutPort[];
  depth: number;
  barsMode?: boolean;
  blockType?: string;                 // SEL function block
  params?: Record<string, string>;    // block settings (PU/DO/DOMINANT/...)
}

export interface LayoutWire {
  id: string;
  points: { x: number; y: number }[];
  fromId: string;
  toId: string;
  feedback?: boolean; // loop-back wire: an output fed back into the logic (e.g. a seal-in latch)
}

export interface LayoutJunction {
  x: number;
  y: number;
}

// A name/description label for a consumed intermediate signal, drawn at its fan-out junction.
export interface LayoutLabel {
  x: number;        // top-left of the label box (also a routing obstacle)
  y: number;
  width: number;
  height: number;
  anchorX: number;  // the driver output point the label annotates
  anchorY: number;
  driverId: string; // the node whose output net this label names (its fan-out wires)
  leaderX?: number; // nearest point ON the net wire (for an optional leader line to the label)
  leaderY?: number;
  name?: string;
  description?: string;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  wires: LayoutWire[];
  junctions: LayoutJunction[];
  labels: LayoutLabel[];
  width: number;
  height: number;
  options: RenderOptions;
}

export interface WireCrossing {
  wire1From: string;
  wire1To: string;
  wire2From: string;
  wire2To: string;
  x: number;
  y: number;
}

export const GATE_W = 60;
export const INPUT_BAR_OFFSET = 12;
export const GATE_W_MULTI = 75;
export const AND_GATE_H_BASE = 45;
export const PORT_SPACING = 15;

export const NOT_TRIANGLE_W = 50;

export const BUBBLE_R = 5;
export const NOT_GATE_TOTAL_W = NOT_TRIANGLE_W + BUBBLE_R * 2 + 5;
export const NOT_GATE_H = 40;

export const INPUT_LABEL_W = 90;
export const OUTPUT_LABEL_W = 90;
export const INPUT_STUB = 10;
export const OUTPUT_STUB = 10;
export const PORT_SIZE = 5;

export const COL_SPACING = 260;
export const ROW_SPACING = 80;
export const PAD_X = 170;

export const PAD_Y = 50;

export const MIN_PORT_GAP = 25;
export const MIN_DOGLEG = 30;
export const MIN_WIRE_SPACING = 10;
export const MIN_CHANNEL_SPACING = 20;
export const WIRE_PAD = MIN_WIRE_SPACING / 2;
export const BUBBLE_STUB = 5;
export const GRID = 5;
// Round a height UP to an even number of grid cells so the vertical centre (h/2) is exactly
// on the grid. AND/OR gate output ports and the OR arc tip both sit at h/2; without this the
// drawn arc tip drifts off-grid and no longer coincides with the port / junction dot.
export const EVEN_CELL = 2 * GRID;

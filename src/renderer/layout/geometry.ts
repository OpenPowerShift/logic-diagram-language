// Pure geometry helpers: node/gate/block sizing, the grid, small utilities. No layout state beyond
// the id counter (reset per layout via resetId).
import type { FlatNode } from '../graph.js';
import { hasMathContent } from '../math-renderer.js';
import {
  PORT_SPACING, AND_GATE_H_BASE, NOT_GATE_H, MIN_PORT_GAP, GRID, EVEN_CELL,
} from './types.js';

export function evenGridHeight(v: number): number { return Math.ceil(v / EVEN_CELL) * EVEN_CELL; }

let _id = 0;
export function resetId(): void { _id = 0; }
export function uid(prefix: string): string { return `${prefix}_${++_id}`; }

export function naturalCompare(a: string, b: string): number {
  const aParts = a.match(/\d+|\D+/g) ?? [a];
  const bParts = b.match(/\d+|\D+/g) ?? [b];
  for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
    const aIsNum = /^\d+$/.test(aParts[i]);
    const bIsNum = /^\d+$/.test(bParts[i]);
    if (aIsNum && bIsNum) {
      const diff = parseInt(aParts[i]) - parseInt(bParts[i]);
      if (diff !== 0) return diff;
    } else {
      const diff = aParts[i].localeCompare(bParts[i]);
      if (diff !== 0) return diff;
    }
  }
  return aParts.length - bParts.length;
}

export function rectsOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number, pad: number = 0): boolean {
  return !(ax + aw + pad < bx || bx + bw + pad < ax || ay + ah + pad < by || by + bh + pad < ay);
}

// The base (pre-expansion) height of a node, mirroring the height logic in the node-creation
// loop. Used by the coordinate assignment to space nodes within a column.
export function baseNodeHeight(n: FlatNode): number {
  if (n.gateType === 'DUMMY') return 0; // a thin long-edge lane; spacing comes from VGAP
  if (n.kind === 'input' || n.kind === 'output') {
    const math = (!!n.name && hasMathContent(n.name)) || (!!n.description && hasMathContent(n.description));
    return n.description || math ? 30 : 20;
  }
  if (n.blockType === 'FB') return fbDims(n).h + (n.description ? 18 : 0);
  if (n.blockType) return blockSize(n.blockType).h + (n.name ? 18 : 0) + (n.description ? 18 : 0);
  if (n.gateType === 'NOT') return NOT_GATE_H;
  const numInputs = n.inputIds.length || 2;
  const labelSpace = (n.name ? 18 : 0) + (n.description ? 18 : 0);
  return gateBodyHeight(numInputs, gateGap(n), labelSpace);
}

// ── Gate vertical layout: single source of truth ──────────────────────────────────────────────
// A gate's body is sized and its ports laid out PURELY from its port count and a per-gate vertical
// port spacing `gap`: input port i sits at top + GATE_END_PAD + i*gap, so adjacent ports are `gap`
// apart with a fixed GATE_END_PAD above the first and below the last; the body height is the span
// plus both pads (rounded up to an even grid so the dead-centre output stays on-grid). With the
// default gap = PORT_SPACING this reproduces the historical (n+1)*PORT_SPACING layout exactly; a
// larger gap (for a gate fed by labelled inputs) widens the port spacing without other passes
// needing to know. Every pass that sizes or re-places a gate body derives geometry from these.
export const GATE_END_PAD = PORT_SPACING;
export function gateBodyHeight(numInputs: number, gap: number = PORT_SPACING, labelSpace = 0): number {
  return evenGridHeight(Math.max(AND_GATE_H_BASE, (numInputs - 1) * gap + 2 * GATE_END_PAD) + labelSpace);
}
export function gateInputPortY(top: number, i: number, gap: number = PORT_SPACING): number {
  return top + GATE_END_PAD + i * gap;
}
// A gate's first-class vertical port spacing (`portGap`), defaulting to PORT_SPACING.
export function gateGap(n: FlatNode): number { return n.portGap ?? PORT_SPACING; }

// Body dimensions for a generic FB block: square-ish, sized to its port counts and labels.
export function fbDims(n: FlatNode): { w: number; h: number } {
  const ni = n.inputIds.length;
  const no = Math.max(1, n.usedPorts?.size ?? 1);
  // Outputs sit at the output-stack gap (40) so the output nodes they feed line up straight;
  // inputs need only MIN_PORT_GAP. Height fits whichever side has more ports.
  const h = Math.max(50, Math.max((no - 1) * 40, (ni - 1) * MIN_PORT_GAP) + 50);
  const textW = (s?: string) => (s ? s.length * 6.5 : 0);
  const inMax = Math.max(0, ...(n.inputLabels ?? []).map(textW));
  const outMax = Math.max(0, ...[...(n.usedPorts ?? [])].map(p => textW(p === 'OUT' ? undefined : p)));
  // Room for the left labels, the centred name and the right labels without overlap.
  const w = Math.max(70, inMax + outMax + textW(n.name) + 30);
  return { w: Math.ceil(w / GRID) * GRID, h: Math.ceil(h / GRID) * GRID };
}

// Body dimensions for each SEL function block.
export function blockSize(blockType: string): { w: number; h: number } {
  switch (blockType) {
    case 'TIMER': return { w: 85, h: 50 };
    case 'SR': return { w: 60, h: 55 };
    case 'COMPARE': return { w: 65, h: 50 };
    case 'RISING': case 'FALLING': return { w: 50, h: 40 };
    default: return { w: 60, h: 45 };
  }
}

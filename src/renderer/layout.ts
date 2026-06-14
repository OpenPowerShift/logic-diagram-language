import type { LogicNode, GateNode, PortNode, Diagram, DiagramOutput, PortMeta, RenderOptions } from '../parser/ast.js';
import { DEFAULT_OPTIONS, resolveOptions } from '../parser/ast.js';

export interface LayoutPort {
  name: string;
  absX: number;
  absY: number;
  bubbled?: boolean;
  bubbledOutput?: boolean;
  style?: 'CIRCLE' | 'SQUARE';
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
}

export interface LayoutWire {
  id: string;
  points: { x: number; y: number }[];
  fromId: string;
  toId: string;
}

export interface LayoutJunction {
  x: number;
  y: number;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  wires: LayoutWire[];
  junctions: LayoutJunction[];
  width: number;
  height: number;
  options: RenderOptions;
}

const GATE_W = 60;
const GATE_W_MULTI = 72;
const AND_GATE_H_BASE = 44;

const NOT_TRIANGLE_W = 50;

const BUBBLE_R = 4;
const NOT_GATE_TOTAL_W = NOT_TRIANGLE_W + BUBBLE_R * 2 + 8;
const NOT_GATE_H = 34;

const INPUT_LABEL_W = 90;
const OUTPUT_LABEL_W = 90;
const INPUT_STUB = 8;
const OUTPUT_STUB = 8;
const PORT_SIZE = 5;

const COL_SPACING = 220;
const ROW_SPACING = 80;
const PAD_X = 170;
const PAD_Y = 50;

const MIN_PORT_GAP = 22;
const MIN_DOGLEG = 30;
const BUBBLE_STUB = 6;
const OR_LEFT_EDGE_MAX_RATIO = 0.18;

let _id = 0;

function orLeftEdgeOffset(y: number, h: number): number {
  if (h <= 0) return 0;
  const t = 1 - y / h;
  const p0x = 0, p1x = OR_LEFT_EDGE_MAX_RATIO, p2x = OR_LEFT_EDGE_MAX_RATIO, p3x = 0;
  return (1 - t) ** 3 * p0x + 3 * (1 - t) ** 2 * t * p1x + 3 * (1 - t) * t ** 2 * p2x + t ** 3 * p3x;
}
function uid(prefix: string): string { return `${prefix}_${++_id}`; }

function naturalCompare(a: string, b: string): number {
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

interface FlatNode {
  id: string;
  kind: 'gate' | 'input' | 'output';
  gateType?: string;
  label?: string;
  name?: string;
  description?: string;
  depth: number;
  inputIds: string[];
  invertedInputs?: Set<number>;
  bubbledOutput?: boolean;
}

function flattenGate(node: LogicNode): LogicNode {
  if (node.kind === 'port') return node;
  if (node.kind === 'symbolRef') return node;
  if (node.kind !== 'gate') return node;

  const flatInputs = node.inputs.map(flattenGate);

  if (node.gateType === 'AND' || node.gateType === 'OR') {
    const merged: LogicNode[] = [];
    for (const input of flatInputs) {
      if (input.kind === 'gate' && input.gateType === node.gateType) {
        merged.push(...input.inputs);
      } else {
        merged.push(input);
      }
    }
    return { kind: 'gate', gateType: node.gateType, inputs: merged } as GateNode;
  }

  return { kind: 'gate', gateType: node.gateType, inputs: flatInputs } as GateNode;
}

function rectsOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number, pad: number = 0): boolean {
  return !(ax + aw + pad < bx || bx + bw + pad < ax || ay + ah + pad < by || by + bh + pad < ay);
}

export function layoutDiagram(diagram: Diagram, portMeta: PortMeta[] = [], options?: RenderOptions): LayoutResult {
  _id = 0;

  const opts = options ?? DEFAULT_OPTIONS;

  const flatOutputs: DiagramOutput[] = diagram.outputs.map(o => ({
    ...o,
    expression: flattenGate(o.expression),
  }));

  const metaMap = new Map<string, { name?: string; description?: string }>();
  for (const m of portMeta) {
    let e = metaMap.get(m.identifier);
    if (!e) { e = {}; metaMap.set(m.identifier, e); }
    if (m.property === 'Name') e.name = m.value;
    if (m.property === 'Description') e.description = m.value;
  }

  const nodes = new Map<string, FlatNode>();
  const inputMap = new Map<string, string>();

  function resolve(node: LogicNode): string {
    if (node.kind === 'port') {
      if (!inputMap.has(node.name)) {
        const id = uid('in');
        const meta = metaMap.get(node.name);
        nodes.set(id, {
          id, kind: 'input', label: node.name,
          name: meta?.name, description: meta?.description,
          depth: 0, inputIds: [],
        });
        inputMap.set(node.name, id);
      }
      return inputMap.get(node.name)!;
    }
    if (node.kind === 'symbolRef') {
      const id = uid('sym');
      nodes.set(id, {
        id, kind: 'gate', gateType: node.symbolName,
        depth: 0, inputIds: [],
      });
      return id;
    }
    if (node.kind === 'gate') {
      const id = uid(node.gateType.toLowerCase());
      const inputIds = node.inputs.map(i => resolve(i));
      const depth = Math.max(...inputIds.map(iid => nodes.get(iid)?.depth ?? 0), 0) + 1;
      nodes.set(id, {
        id, kind: 'gate', gateType: node.gateType,
        depth, inputIds,
      });
      return id;
    }
    return uid('unknown');
  }

  const outputMeta = new Map<string, { name?: string; description?: string }>();
  for (const m of portMeta) {
    let e = outputMeta.get(m.identifier);
    if (!e) { e = {}; outputMeta.set(m.identifier, e); }
    if (m.property === 'Name') e.name = m.value;
    if (m.property === 'Description') e.description = m.value;
  }

  for (const output of flatOutputs) {
    const outputId = uid('out');
    const exprId = resolve(output.expression);
    const meta = outputMeta.get(output.name);
    nodes.set(outputId, {
      id: outputId, kind: 'output', label: output.name,
      name: meta?.name, description: meta?.description,
      depth: (nodes.get(exprId)?.depth ?? 0) + 1,
      inputIds: [exprId],
    });
  }

  // INVERSION = BUBBLES: absorb NOT gates into downstream ports with inversion bubbles
  if (opts.inversion === 'BUBBLES') {
    const notNodes = Array.from(nodes.values())
      .filter(n => n.kind === 'gate' && n.gateType === 'NOT');

    // Build NOT chains: for each NOT, follow its input chain of NOTs to find
    // the ultimate (non-NOT) source and the total inversion depth.
    // This avoids mutation-while-iterating issues with chained NOT resolution.
    const notChainInfo = new Map<string, { sourceId: string; inversionDepth: number }>();

    for (const notNode of notNodes) {
      if (notNode.inputIds.length !== 1) continue;
      let sourceId = notNode.inputIds[0];
      let depth = 1;

      // Walk the chain of NOTs to find the ultimate source
      while (true) {
        const sourceNode = nodes.get(sourceId);
        if (sourceNode && sourceNode.kind === 'gate' && sourceNode.gateType === 'NOT' && sourceNode.inputIds.length === 1) {
          depth++;
          sourceId = sourceNode.inputIds[0];
        } else {
          break;
        }
      }

      notChainInfo.set(notNode.id, { sourceId, inversionDepth: depth });
    }

    // Identify outermost NOTs: a NOT is outermost if no other NOT has it as input.
    // Only process outermost NOTs — each chain is handled once.
    const outermostNots = notNodes.filter(n => {
      for (const other of notNodes) {
        if (other.id !== n.id && other.inputIds.includes(n.id)) return false;
      }
      return true;
    });

    for (const notNode of outermostNots) {
      const info = notChainInfo.get(notNode.id);
      if (!info) continue;
      const { sourceId, inversionDepth } = info;

      // Replace all NOT node references in this chain with the ultimate source
      for (const otherNode of nodes.values()) {
        if (otherNode.kind === 'gate' && otherNode.gateType === 'NOT') continue;
        for (let i = 0; i < otherNode.inputIds.length; i++) {
          // Walk up the NOT chain to see if this input references any NOT in this chain
          let ref = otherNode.inputIds[i];
          while (notChainInfo.has(ref)) {
            otherNode.inputIds[i] = sourceId;
            const chainInfo = notChainInfo.get(ref)!;
            ref = chainInfo.sourceId;
          }
          // Also directly replace the outermost NOT id
          if (otherNode.inputIds[i] === notNode.id) {
            otherNode.inputIds[i] = sourceId;
          }
        }
      }

      // Odd inversions produce a bubble; even inversions cancel out
      if (inversionDepth % 2 === 1) {
        const sourceNode = nodes.get(sourceId);
        if (sourceNode && sourceNode.kind === 'gate' && sourceNode.gateType !== 'NOT') {
          sourceNode.bubbledOutput = true;
        } else {
          for (const otherNode of nodes.values()) {
            if (otherNode.kind === 'gate' && otherNode.gateType === 'NOT') continue;
            for (let i = 0; i < otherNode.inputIds.length; i++) {
              if (otherNode.inputIds[i] === sourceId) {
                if (otherNode.kind === 'gate' || otherNode.kind === 'output') {
                  if (!otherNode.invertedInputs) otherNode.invertedInputs = new Set();
                  otherNode.invertedInputs.add(i);
                }
              }
            }
          }
        }
      }
    }

    // Remove all NOT nodes
    for (const n of notNodes) {
      nodes.delete(n.id);
    }

    // Recalculate depths after removing NOTs — nodes may have shallower depths now
    const depthOrder = Array.from(nodes.values()).sort((a, b) => a.depth - b.depth);
    for (const node of depthOrder) {
      if (node.kind === 'input') {
        node.depth = 0;
      } else {
        const inputDepths = node.inputIds
          .map(id => nodes.get(id)?.depth ?? 0);
        node.depth = (inputDepths.length > 0 ? Math.max(...inputDepths) : 0) + 1;
      }
    }

    // Compress depth values to remove gaps
    const usedDepths = [...new Set(Array.from(nodes.values()).map(n => n.depth))].sort((a, b) => a - b);
    const depthRemap = new Map<number, number>();
    usedDepths.forEach((d, i) => depthRemap.set(d, i));
    for (const node of nodes.values()) {
      node.depth = depthRemap.get(node.depth) ?? node.depth;
    }
  }

  const rowMap = new Map<string, number>();

  const depthGroups = new Map<number, FlatNode[]>();
  for (const n of nodes.values()) {
    if (!depthGroups.has(n.depth)) depthGroups.set(n.depth, []);
    depthGroups.get(n.depth)!.push(n);
  }

  const inputGroup = depthGroups.get(0) ?? [];
  inputGroup.sort((a, b) => naturalCompare(a.label ?? a.id, b.label ?? b.id));
  for (let i = 0; i < inputGroup.length; i++) {
    rowMap.set(inputGroup[i].id, i);
  }

  const maxDepth = Math.max(...Array.from(nodes.values()).map(n => n.depth), 0);

  for (let depth = 1; depth <= maxDepth; depth++) {
    const group = depthGroups.get(depth) ?? [];
    for (const node of group) {
      if (node.inputIds.length === 0) {
        rowMap.set(node.id, 0);
        continue;
      }
      const inputRows = node.inputIds
        .map(id => rowMap.get(id))
        .filter((r): r is number => r !== undefined);
      if (inputRows.length === 0) {
        rowMap.set(node.id, 0);
        continue;
      }
      const minR = Math.min(...inputRows);
      const maxR = Math.max(...inputRows);
      rowMap.set(node.id, (minR + maxR) / 2);
    }
  }

  for (let iteration = 0; iteration < 3; iteration++) {
    const sortedInputGroup = [...inputGroup];
    for (const node of sortedInputGroup) {
      const downNodes = Array.from(nodes.values()).filter(n => n.inputIds.includes(node.id));
      if (downNodes.length > 0) {
        const bary = downNodes.reduce((s, n) => s + (rowMap.get(n.id) ?? 0), 0) / downNodes.length;
        rowMap.set(node.id, bary);
      }
    }
    sortedInputGroup.sort((a, b) => (rowMap.get(a.id) ?? 0) - (rowMap.get(b.id) ?? 0));
    for (let i = 0; i < sortedInputGroup.length; i++) {
      rowMap.set(sortedInputGroup[i].id, i);
    }

    for (let depth = 1; depth <= maxDepth; depth++) {
      const group = depthGroups.get(depth) ?? [];
      for (const node of group) {
        if (node.inputIds.length === 0) {
          rowMap.set(node.id, 0);
          continue;
        }
        const inputRows = node.inputIds
          .map(id => rowMap.get(id))
          .filter((r): r is number => r !== undefined);
        if (inputRows.length === 0) {
          rowMap.set(node.id, 0);
          continue;
        }
        const minR = Math.min(...inputRows);
        const maxR = Math.max(...inputRows);
        rowMap.set(node.id, (minR + maxR) / 2);
      }
    }
  }

  const allRows = Array.from(new Set(Array.from(rowMap.values()))).sort((a, b) => a - b);
  const rowToGrid = new Map<number, number>();
  for (let i = 0; i < allRows.length; i++) {
    rowToGrid.set(allRows[i], i);
  }

  const layoutNodes: LayoutNode[] = [];
  const nodeMap = new Map<string, LayoutNode>();

  for (const node of nodes.values()) {
    const gridRow = rowToGrid.get(rowMap.get(node.id) ?? 0) ?? 0;
    const absY = gridRow * ROW_SPACING + PAD_Y;
    const absX = PAD_X + node.depth * COL_SPACING;

    let w: number, h: number;

    if (node.kind === 'input') {
      w = INPUT_LABEL_W;
      h = node.description ? 28 : 20;
      const outX = absX + w + INPUT_STUB;
      const outY = absY + h / 2;

      const ln: LayoutNode = {
        id: node.id, gateType: 'INPUT', label: node.label,
        name: node.name, description: node.description,
        absX, absY, width: w + INPUT_STUB, height: h,
        inputs: [], outputs: [{ name: 'out', absX: outX, absY: outY }],
        depth: node.depth,
      };
      layoutNodes.push(ln);
      nodeMap.set(node.id, ln);
    } else if (node.kind === 'output') {
      w = OUTPUT_LABEL_W;
      h = node.description ? 28 : 20;
      let inX = absX;
      const inY = absY + h / 2;
      let bubbledInput = false;

      // Mark bubbled input (BUBBLES mode: NOT feeding into output)
      if (node.invertedInputs && node.invertedInputs.has(0)) {
        bubbledInput = true;
        inX -= BUBBLE_R * 2;
      }

      const ln: LayoutNode = {
        id: node.id, gateType: 'OUTPUT', label: node.label,
        name: node.name, description: node.description,
        absX, absY, width: w + OUTPUT_STUB, height: h,
        inputs: [{ name: 'in', absX: inX, absY: inY, bubbled: bubbledInput || undefined }], outputs: [],
        depth: node.depth,
      };
      layoutNodes.push(ln);
      nodeMap.set(node.id, ln);
    } else if (node.gateType === 'NOT') {
      w = NOT_GATE_TOTAL_W;
      h = NOT_GATE_H;

      const ln: LayoutNode = {
        id: node.id, gateType: 'NOT', label: node.label,
        absX, absY, width: w, height: h,
        inputs: [{ name: 'in_0', absX: absX, absY: absY + h / 2 }],
        outputs: [{ name: 'out', absX: absX + w, absY: absY + h / 2 }],
        depth: node.depth,
      };
      layoutNodes.push(ln);
      nodeMap.set(node.id, ln);
    } else {
      const numInputs = node.inputIds.length || 2;
      const isMultiInput = numInputs > 2;
      const useBars = opts.gateInputStyle === 'BARS' && numInputs > 2;

      if (useBars) {
        h = AND_GATE_H_BASE;
        w = isMultiInput ? GATE_W_MULTI : GATE_W;
      } else {
        h = Math.max(AND_GATE_H_BASE, numInputs * 22 + 8);
        w = isMultiInput ? GATE_W_MULTI : GATE_W;
      }

      const inputs: LayoutPort[] = [];
      if (useBars) {
        // BARS mode: first 2 inputs on gate body, rest via vertical bar
        const portSpacing = h / 3;
        for (let i = 0; i < Math.min(2, numInputs); i++) {
          const portY = absY + (i + 1) * portSpacing;
          inputs.push({ name: `in_${i}`, absX: absX, absY: portY });
        }
        for (let i = 2; i < numInputs; i++) {
          const spacing = (h - 2 * AND_GATE_H_BASE / 3) / (numInputs - 1);
          const portY = absY + AND_GATE_H_BASE / 3 + (i - 2) * Math.min(spacing, MIN_PORT_GAP);
          inputs.push({ name: `in_${i}`, absX: absX - 12, absY: portY });
        }
} else {
      for (let i = 0; i < numInputs; i++) {
        const portY = absY + (i + 1) * h / (numInputs + 1);
        let portX = absX;
        // OR gates have a curved left edge; offset input ports to touch the curve
        if (node.gateType === 'OR') {
          portX = absX + orLeftEdgeOffset(portY - absY, h) * w;
        }
        inputs.push({ name: `in_${i}`, absX: portX, absY: portY });
      }
    }

    // Mark inverted inputs (BUBBLES mode) and shift bubbled ports left for bubble + stub
    if (node.invertedInputs) {
      for (const idx of node.invertedInputs) {
        if (idx < inputs.length) {
          inputs[idx].bubbled = true;
          // Shift bubbled input port left so wire endpoint = bubble left edge = gate edge - BUBBLE_R*2
          inputs[idx].absX -= BUBBLE_R * 2;
        }
      }
    }

      // Apply per-port style overrides
      const styleMap = new Map<string, 'CIRCLE' | 'SQUARE'>();
      for (const m of portMeta) {
        if (m.property === 'Style') styleMap.set(m.identifier, m.value.toUpperCase() as 'CIRCLE' | 'SQUARE');
      }

      const gateCenterY = absY + h / 2;
      const outputs: LayoutPort[] = [{ name: 'out', absX: absX + w, absY: gateCenterY }];

      // Mark bubbled output (BUBBLES mode) and shift output port right for bubble
      if (node.bubbledOutput) {
        outputs[0].bubbledOutput = true;
        outputs[0].absX += BUBBLE_R * 2;
      }

      const ln: LayoutNode = {
        id: node.id, gateType: node.gateType ?? 'AND', label: node.label,
        name: node.name, description: node.description,
        absX, absY, width: w, height: h,
        inputs, outputs, depth: node.depth,
        barsMode: useBars ? true : undefined,
      };
      layoutNodes.push(ln);
      nodeMap.set(node.id, ln);
    }
  }

  for (const gateNode of layoutNodes) {
    if (gateNode.gateType === 'INPUT' || gateNode.gateType === 'OUTPUT') continue;
    const gateTop = gateNode.absY;
    const gateBottom = gateNode.absY + gateNode.height;
    const gateRight = gateNode.absX;

    for (const inputNode of layoutNodes) {
      if (inputNode.gateType !== 'INPUT') continue;
      if (inputNode.absX >= gateRight) continue;

      const inputBottom = inputNode.absY + inputNode.height;
      if (inputBottom > gateTop && inputNode.absY < gateBottom && inputNode.absY < gateTop + 5) {
        const shift = inputBottom - gateTop + 5;
        gateNode.absY += shift;
        for (const port of gateNode.inputs) port.absY += shift;
        for (const port of gateNode.outputs) port.absY += shift;
      }
    }
  }

  for (const node of nodes.values()) {
    if (node.kind !== 'gate' || node.inputIds.length !== 1) continue;
    const gateNode = nodeMap.get(node.id);
    if (!gateNode || gateNode.inputs.length !== 1) continue;
    const sourceId = node.inputIds[0];
    const sourceNode = nodeMap.get(sourceId);
    if (!sourceNode || sourceNode.outputs.length === 0) continue;
    const sourceOutputY = sourceNode.outputs[0].absY;
    const offsetY = sourceOutputY - gateNode.inputs[0].absY;
    gateNode.absY += offsetY;
    gateNode.inputs[0].absY = sourceOutputY;
    if (gateNode.outputs.length > 0) {
      gateNode.outputs[0].absY += offsetY;
    }
  }

  for (const node of nodes.values()) {
    if (node.kind !== 'output') continue;
    const outputNode = nodeMap.get(node.id);
    if (!outputNode || node.inputIds.length === 0) continue;
    const sourceId = node.inputIds[0];
    const sourceNode = nodeMap.get(sourceId);
    if (!sourceNode || sourceNode.outputs.length === 0) continue;
    const sourceOutputY = sourceNode.outputs[0].absY;
    outputNode.inputs[0].absY = sourceOutputY;
    outputNode.absY = sourceOutputY - outputNode.height / 2;
  }

  for (const node of nodes.values()) {
    if (node.kind !== 'gate' || !node.gateType || node.gateType === 'NOT') continue;
    if (node.inputIds.length < 2) continue;
    const gateNode = nodeMap.get(node.id);
    if (!gateNode || gateNode.inputs.length < 2) continue;

    const sortedInputIds = [...node.inputIds];
    const inputYs = sortedInputIds.map(id => {
      const src = nodeMap.get(id);
      return src?.outputs[0]?.absY ?? Infinity;
    });
    const indexed = sortedInputIds.map((id, i) => ({ id, absY: inputYs[i] }));
    indexed.sort((a, b) => a.absY - b.absY);

    const sourceYs = indexed.map(e => e.absY).filter(y => y !== Infinity);
    if (sourceYs.length === 0) continue;

    const idealYs: number[] = [sourceYs[0]];
    for (let i = 1; i < sourceYs.length; i++) {
      idealYs.push(Math.max(sourceYs[i], idealYs[i - 1] + MIN_PORT_GAP));
    }

    const topPad = MIN_PORT_GAP;
    const bottomPad = MIN_PORT_GAP;
    const requiredTop = idealYs[0] - topPad;
    const requiredBottom = idealYs[idealYs.length - 1] + bottomPad;
    const requiredHeight = requiredBottom - requiredTop;

    const maxExpansion = MIN_PORT_GAP * gateNode.inputs.length;
    if (requiredHeight <= gateNode.height + maxExpansion) {
      gateNode.absY = requiredTop;
      gateNode.height = Math.max(gateNode.height, requiredHeight);
      for (let i = 0; i < indexed.length && i < gateNode.inputs.length; i++) {
        gateNode.inputs[i].absY = idealYs[i];
      }
      if (gateNode.outputs.length > 0) {
        gateNode.outputs[0].absY = gateNode.absY + gateNode.height / 2;
      }
    }
  }

  for (const node of nodes.values()) {
    if (node.kind !== 'gate' || !node.gateType || node.gateType === 'NOT') continue;
    if (node.inputIds.length < 2) continue;
    const gateNode = nodeMap.get(node.id);
    if (!gateNode || gateNode.inputs.length < 2) continue;

    const sortedInputIds = [...node.inputIds];
    const inputYs = sortedInputIds.map(id => {
      const src = nodeMap.get(id);
      return src?.outputs[0]?.absY ?? Infinity;
    });
    const indexed = sortedInputIds.map((id, i) => ({ id, absY: inputYs[i] }));
    indexed.sort((a, b) => a.absY - b.absY);
    const sourceYs = indexed.map(e => e.absY).filter(y => y !== Infinity);

    const currentPortYs = gateNode.inputs.map(p => p.absY);
    const expanded = sourceYs.length === currentPortYs.length &&
      sourceYs.every((sy, i) => Math.abs(sy - currentPortYs[i]) < 1);
    if (expanded) continue;

    const h = gateNode.height;
    const n = gateNode.inputs.length;
    const originalAbsY = gateNode.absY;

    function smallDoglegScore(delta: number): number {
      let score = 0;
      for (let i = 0; i < sourceYs.length && i < n; i++) {
        const portY = originalAbsY + delta + (i + 1) * h / (n + 1);
        const diff = Math.abs(sourceYs[i] - portY);
        if (diff >= 1 && diff < MIN_DOGLEG) {
          score += (MIN_DOGLEG - diff) * (MIN_DOGLEG - diff);
        }
      }
      return score;
    }

    let bestDelta = 0;
    let bestScore = smallDoglegScore(0);
    for (let delta = -MIN_DOGLEG; delta <= MIN_DOGLEG; delta += 0.5) {
      const score = smallDoglegScore(delta);
      if (score < bestScore || (score === bestScore && Math.abs(delta) < Math.abs(bestDelta))) {
        bestScore = score;
        bestDelta = delta;
      }
    }

    if (Math.abs(bestDelta) >= 0.5) {
      gateNode.absY += bestDelta;
      for (const port of gateNode.inputs) {
        port.absY += bestDelta;
      }
      if (gateNode.outputs.length > 0) {
        gateNode.outputs[0].absY += bestDelta;
      }
    }
  }

  // Dogleg enforcement: ensure no wire has 0 < |sourceY - portY| < MIN_DOGLEG.
  // For any input where this constraint is violated, expand the gate to accommodate
  // the port at the source Y position (straight-through) or at source Y ± MIN_DOGLEG.
  for (const node of nodes.values()) {
    if (node.kind !== 'gate' || !node.gateType || node.gateType === 'NOT') continue;
    if (node.inputIds.length < 2) continue;
    const gateNode = nodeMap.get(node.id);
    if (!gateNode || gateNode.inputs.length < 2) continue;

    const sortedInputIds = [...node.inputIds];
    const inputYs = sortedInputIds.map(id => {
      const src = nodeMap.get(id);
      return src?.outputs[0]?.absY ?? Infinity;
    });
    const indexed = sortedInputIds.map((id, i) => ({ id, absY: inputYs[i] }));
    indexed.sort((a, b) => a.absY - b.absY);
    const sourceYs = indexed.map(e => e.absY).filter(y => y !== Infinity);

    let needsExpansion = false;
    for (let i = 0; i < sourceYs.length && i < gateNode.inputs.length; i++) {
      const diff = Math.abs(sourceYs[i] - gateNode.inputs[i].absY);
      if (diff >= 1 && diff < MIN_DOGLEG) {
        needsExpansion = true;
        break;
      }
    }

    if (!needsExpansion) continue;

    // Re-expand: place ports at ideal Y positions with MIN_PORT_GAP between adjacent ports,
    // preferring source Y positions where possible.
    const idealYs: number[] = [sourceYs[0]];
    for (let i = 1; i < sourceYs.length; i++) {
      idealYs.push(Math.max(sourceYs[i], idealYs[i - 1] + MIN_PORT_GAP));
    }

    const topPad = MIN_PORT_GAP;
    const bottomPad = MIN_PORT_GAP;
    const requiredTop = idealYs[0] - topPad;
    const requiredBottom = idealYs[idealYs.length - 1] + bottomPad;
    const requiredHeight = requiredBottom - requiredTop;

    const maxExpansion = MIN_DOGLEG * gateNode.inputs.length;
    if (requiredHeight <= gateNode.height + maxExpansion) {
      gateNode.absY = requiredTop;
      gateNode.height = Math.max(gateNode.height, requiredHeight);
      for (let i = 0; i < indexed.length && i < gateNode.inputs.length; i++) {
        gateNode.inputs[i].absY = idealYs[i];
      }
      if (gateNode.outputs.length > 0) {
        gateNode.outputs[0].absY = gateNode.absY + gateNode.height / 2;
      }
    } else {
      // Cannot expand enough. For each port with a small dogleg, snap to source Y
      // if it doesn't violate MIN_PORT_GAP with neighbours.
      const currentYs = gateNode.inputs.map(p => p.absY);
      for (let i = 0; i < sourceYs.length && i < gateNode.inputs.length; i++) {
        const diff = Math.abs(sourceYs[i] - currentYs[i]);
        if (diff >= 1 && diff < MIN_DOGLEG) {
          const candidateY = sourceYs[i];
          const prevY = i > 0 ? gateNode.inputs[i - 1].absY : gateNode.absY;
          const nextY = i < gateNode.inputs.length - 1 ? gateNode.inputs[i + 1].absY : gateNode.absY + gateNode.height;
          if (candidateY - prevY >= MIN_PORT_GAP && nextY - candidateY >= MIN_PORT_GAP) {
            gateNode.inputs[i].absY = candidateY;
          } else {
            // Snap to MIN_DOGLEG away from source
            if (candidateY > currentYs[i]) {
              gateNode.inputs[i].absY = sourceYs[i] + MIN_DOGLEG;
            } else {
              gateNode.inputs[i].absY = sourceYs[i] - MIN_DOGLEG;
            }
          }
        }
      }
    }
  }

  // Re-align output nodes after all gate position adjustments
  for (const node of nodes.values()) {
    if (node.kind !== 'output') continue;
    const outputNode = nodeMap.get(node.id);
    if (!outputNode || node.inputIds.length === 0) continue;
    const sourceId = node.inputIds[0];
    const sourceNode = nodeMap.get(sourceId);
    if (!sourceNode || sourceNode.outputs.length === 0) continue;
    const sourceOutputY = sourceNode.outputs[0].absY;
    outputNode.inputs[0].absY = sourceOutputY;
    outputNode.absY = sourceOutputY - outputNode.height / 2;
  }

  const wires: LayoutWire[] = [];
  const junctions: LayoutJunction[] = [];
  const fanOutMap = new Map<string, { x: number; y: number; count: number }>();

  const gateRects = layoutNodes
    .filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT')
    .map(n => ({ x: n.absX, y: n.absY, w: n.width, h: n.height, id: n.id }));

  // Track previously-routed wire segments for crossing avoidance
  const routedHorizontals: { y: number; xMin: number; xMax: number; fromId: string }[] = [];
  const routedVerticals: { x: number; yMin: number; yMax: number; fromId: string }[] = [];

  for (const node of nodes.values()) {
    if (node.inputIds.length === 0) continue;
    const toLayoutNode = nodeMap.get(node.id);
    if (!toLayoutNode) continue;

    const sortedInputIds = [...node.inputIds];
    if (node.kind === 'gate' && (node.gateType === 'AND' || node.gateType === 'OR')) {
      const inputYs = sortedInputIds.map((srcId) => {
        const srcNode = nodeMap.get(srcId);
        if (!srcNode) return Infinity;
        return srcNode.outputs[0]?.absY ?? Infinity;
      });
      const indexed = sortedInputIds.map((id, i) => ({ id, absY: inputYs[i], originalIndex: i }));
      indexed.sort((a, b) => a.absY - b.absY);
      sortedInputIds.length = 0;
      for (const item of indexed) {
        sortedInputIds.push(item.id);
      }
    }

    const wireData: { fromId: string; fx: number; fy: number; tx: number; ty: number }[] = [];
    for (let i = 0; i < sortedInputIds.length; i++) {
      const fromId = sortedInputIds[i];
      const fromLayoutNode = nodeMap.get(fromId);
      if (!fromLayoutNode) continue;

      const fromPort = fromLayoutNode.outputs[0];
      if (!fromPort) continue;

      const toPortIdx = Math.min(i, toLayoutNode.inputs.length - 1);
      const toPort = toLayoutNode.inputs[toPortIdx];
      if (!toPort) continue;

      wireData.push({ fromId, fx: fromPort.absX, fy: fromPort.absY, tx: toPort.absX, ty: toPort.absY });
    }

    const aboveWires = wireData.filter(w => w.fy < toLayoutNode.absY);
    const belowWires = wireData.filter(w => w.fy >= toLayoutNode.absY);
    const mixedSides = aboveWires.length > 0 && belowWires.length > 0;

    function verticalSpansOverlap(wires: { fy: number; ty: number }[]): boolean {
      if (wires.length <= 1) return false;
      const spans = wires.map(w => ({ min: Math.min(w.fy, w.ty), max: Math.max(w.fy, w.ty) }));
      for (let i = 0; i < spans.length; i++) {
        for (let j = i + 1; j < spans.length; j++) {
          const overlapStart = Math.max(spans[i].min, spans[j].min);
          const overlapEnd = Math.min(spans[i].max, spans[j].max);
          if (overlapEnd - overlapStart > 5) return true;
        }
      }
      return false;
    }

    const allOverlap = verticalSpansOverlap(wireData);
    const channelXAll = wireData.length > 1 && !allOverlap ? computeSharedChannel(wireData, gateRects, toLayoutNode) : undefined;

    const aboveOverlap = verticalSpansOverlap(aboveWires);
    const belowOverlap = verticalSpansOverlap(belowWires);
    const channelXAbove = aboveWires.length > 1 && !aboveOverlap ? computeSharedChannel(aboveWires, gateRects, toLayoutNode) : undefined;
    const channelXBelow = belowWires.length > 1 && !belowOverlap ? computeSharedChannel(belowWires, gateRects, toLayoutNode) : undefined;

    for (let i = 0; i < wireData.length; i++) {
      const { fromId, fx, fy, tx, ty } = wireData[i];

      let channelX: number | undefined;
      if (channelXAll !== undefined) {
        channelX = channelXAll;
      } else if (mixedSides) {
        if (fy < toLayoutNode.absY) {
          channelX = channelXAbove;
        } else {
          channelX = channelXBelow;
        }
      } else {
        channelX = channelXAbove ?? channelXBelow;
      }

      if (channelX === undefined) {
        channelX = computeIndividualChannel(fx, fy, tx, ty, i, wireData.length, gateRects);
      }

      const fanKey = fromId;
      if (!fanOutMap.has(fanKey)) {
        fanOutMap.set(fanKey, { x: fx, y: fy, count: 0 });
      }
      fanOutMap.get(fanKey)!.count++;

      const points = routeWire(fx, fy, tx, ty, gateRects, fromId, node.id, channelX, routedHorizontals, routedVerticals);

      // Record segments for crossing avoidance by subsequent wires
      for (let si = 0; si < points.length - 1; si++) {
        const p0 = points[si], p1 = points[si + 1];
        if (Math.abs(p0.y - p1.y) < 1) {
          routedHorizontals.push({ y: p0.y, xMin: Math.min(p0.x, p1.x), xMax: Math.max(p0.x, p1.x), fromId });
        } else if (Math.abs(p0.x - p1.x) < 1) {
          routedVerticals.push({ x: p0.x, yMin: Math.min(p0.y, p1.y), yMax: Math.max(p0.y, p1.y), fromId });
        }
      }

      wires.push({
        id: uid('wire'),
        points,
        fromId,
        toId: node.id,
      });
    }
  }

  for (const [, info] of fanOutMap) {
    // Junction dots at source ports are added only if a T-branch is detected below
  }

  const junctionSet = new Set<string>();
  for (const j of junctions) {
    junctionSet.add(`${Math.round(j.x)},${Math.round(j.y)}`);
  }

  function addJunction(x: number, y: number) {
    const key = `${Math.round(x)},${Math.round(y)}`;
    if (!junctionSet.has(key)) {
      junctionSet.add(key);
      junctions.push({ x, y });
    }
  }

  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      if (wires[i].fromId !== wires[j].fromId) continue;
      for (let k = 1; k < wires[i].points.length - 1; k++) {
        const pk = wires[i].points[k];
        for (let m = 0; m < wires[j].points.length - 1; m++) {
          const s0 = wires[j].points[m];
          const s1 = wires[j].points[m + 1];
          if (Math.abs(s0.y - s1.y) < 1 && Math.abs(pk.y - s0.y) < 2) {
            const minX = Math.min(s0.x, s1.x);
            const maxX = Math.max(s0.x, s1.x);
            if (pk.x >= minX - 1 && pk.x <= maxX + 1) {
              addJunction(pk.x, pk.y);
            }
          }
          if (Math.abs(s0.x - s1.x) < 1 && Math.abs(pk.x - s0.x) < 2) {
            const minY = Math.min(s0.y, s1.y);
            const maxY = Math.max(s0.y, s1.y);
            if (pk.y >= minY - 1 && pk.y <= maxY + 1) {
              addJunction(pk.x, pk.y);
            }
          }
        }
      }
      for (let k = 1; k < wires[j].points.length - 1; k++) {
        const pk = wires[j].points[k];
        for (let m = 0; m < wires[i].points.length - 1; m++) {
          const s0 = wires[i].points[m];
          const s1 = wires[i].points[m + 1];
          if (Math.abs(s0.y - s1.y) < 1 && Math.abs(pk.y - s0.y) < 2) {
            const minX = Math.min(s0.x, s1.x);
            const maxX = Math.max(s0.x, s1.x);
            if (pk.x >= minX - 1 && pk.x <= maxX + 1) {
              addJunction(pk.x, pk.y);
            }
          }
          if (Math.abs(s0.x - s1.x) < 1 && Math.abs(pk.x - s0.x) < 2) {
            const minY = Math.min(s0.y, s1.y);
            const maxY = Math.max(s0.y, s1.y);
            if (pk.y >= minY - 1 && pk.y <= maxY + 1) {
              addJunction(pk.x, pk.y);
            }
          }
        }
      }
    }
  }

  const maxX = Math.max(...layoutNodes.map(n => n.absX + n.width), ...wires.flatMap(w => w.points.map(p => p.x)));
  const maxY = Math.max(...layoutNodes.map(n => n.absY + n.height), ...wires.flatMap(w => w.points.map(p => p.y)));

  return {
    nodes: layoutNodes,
    wires,
    junctions,
    width: maxX,
    height: maxY,
    options: opts,
  };
}

function computeIndividualChannel(
  fx: number, fy: number, tx: number, ty: number,
  wireIndex: number, totalWires: number,
  obstacles: { x: number; y: number; w: number; h: number; id: string }[],
): number {
  const midX = fx + (tx - fx) * 0.5;
  const minChannelX = fx + 20;
  const channelSpacing = 20;
  const reversedIndex = totalWires - 1 - wireIndex;
  const offset = (reversedIndex - (totalWires - 1) / 2) * channelSpacing;
  return Math.max(minChannelX, midX + offset);
}

function computeSharedChannel(
  wireData: { fx: number; fy: number; tx: number; ty: number }[],
  obstacles: { x: number; y: number; w: number; h: number; id: string }[],
  destNode: LayoutNode,
): number | undefined {
  if (wireData.length <= 1) return undefined;

  const destX = destNode.absX;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const wd of wireData) {
    minX = Math.min(minX, wd.fx, wd.tx);
    maxX = Math.max(maxX, wd.fx, wd.tx);
  }
  const preferredX = (minX + maxX) / 2;
  const minChannelX = Math.max(...wireData.map(wd => wd.fx + 20));

  const yMin = Math.min(...wireData.map(wd => Math.min(wd.fy, wd.ty))) - 4;
  const yMax = Math.max(...wireData.map(wd => Math.max(wd.fy, wd.ty))) + 4;

  function hitsObstacle(testX: number): boolean {
    for (const obs of obstacles) {
      if (rectsOverlap(testX - 4, yMin, 8, yMax - yMin, obs.x, obs.y, obs.w, obs.h, 2)) {
        return true;
      }
    }
    return false;
  }

  let channelX = Math.max(preferredX, minChannelX);
  if (hitsObstacle(channelX)) {
    for (let offset = 20; offset < 300; offset += 20) {
      if (!hitsObstacle(channelX + offset)) { channelX = channelX + offset; break; }
      if (!hitsObstacle(channelX - offset) && channelX - offset >= minChannelX) { channelX = channelX - offset; break; }
    }
  }

  return channelX;
}

function channelHitsObstacle(testX: number, y1: number, y2: number, obs: { x: number; y: number; w: number; h: number; id: string }[]): boolean {
  const yMin = Math.min(y1, y2) - 4;
  const yMax = Math.max(y1, y2) + 4;
  for (const o of obs) {
    if (rectsOverlap(testX - 4, yMin, 8, yMax - yMin, o.x, o.y, o.w, o.h, 2)) {
      return true;
    }
  }
  return false;
}

function routeWire(
  fx: number, fy: number,
  tx: number, ty: number,
  obstacles: { x: number; y: number; w: number; h: number; id: string }[],
  fromId: string,
  toId: string,
  sharedChannelX: number | undefined = undefined,
  routedHorizontals: { y: number; xMin: number; xMax: number; fromId: string }[] = [],
  routedVerticals: { x: number; yMin: number; yMax: number; fromId: string }[] = [],
): { x: number; y: number }[] {

  const dy = Math.abs(fy - ty);

  if (dy < 1) {
    return [{ x: fx, y: fy }, { x: tx, y: ty }];
  }

  function horizontalCrossesVertical(y: number, xMin: number, xMax: number, vertFromId: string): boolean {
    for (const v of routedVerticals) {
      if (v.fromId === vertFromId) continue;
      if (y >= v.yMin - 1 && y <= v.yMax + 1 && v.x >= xMin - 1 && v.x <= xMax + 1) {
        return true;
      }
    }
    return false;
  }

  function verticalCrossesHorizontal(x: number, yMin: number, yMax: number, vertFromId: string): boolean {
    for (const h of routedHorizontals) {
      if (h.fromId === vertFromId) continue;
      if (x >= h.xMin - 1 && x <= h.xMax + 1 && h.y >= yMin - 1 && h.y <= yMax + 1) {
        return true;
      }
    }
    return false;
  }

  function channelClear(testX: number, y1: number, y2: number): boolean {
    const yMin = Math.min(y1, y2);
    const yMax = Math.max(y1, y2);
    if (!channelHitsObstacle(testX, y1, y2, obstacles)) {
      if (verticalCrossesHorizontal(testX, yMin - 4, yMax + 4, fromId)) {
        return false;
      }
      return true;
    }
    return false;
  }

  if (sharedChannelX !== undefined) {
    if (channelClear(sharedChannelX, fy, ty)) {
      const hCrossesStart = horizontalCrossesVertical(fy, Math.min(fx, sharedChannelX), Math.max(fx, sharedChannelX), fromId);
      const hCrossesEnd = horizontalCrossesVertical(ty, Math.min(sharedChannelX, tx), Math.max(sharedChannelX, tx), fromId);
      if (!hCrossesStart && !hCrossesEnd) {
        return [{ x: fx, y: fy }, { x: sharedChannelX, y: fy }, { x: sharedChannelX, y: ty }, { x: tx, y: ty }];
      }
    }
  }

  const midX = fx + (tx - fx) * 0.5;
  const minChannelX = fx + 20;

  let preferredChannelX = Math.max(midX, minChannelX);

  if (channelClear(preferredChannelX, fy, ty)) {
    const hCrossesStart = horizontalCrossesVertical(fy, Math.min(fx, preferredChannelX), Math.max(fx, preferredChannelX), fromId);
    const hCrossesEnd = horizontalCrossesVertical(ty, Math.min(preferredChannelX, tx), Math.max(preferredChannelX, tx), fromId);
    if (!hCrossesStart && !hCrossesEnd) {
      return [{ x: fx, y: fy }, { x: preferredChannelX, y: fy }, { x: preferredChannelX, y: ty }, { x: tx, y: ty }];
    }
  }

  const searchOrder: number[] = [];

  const betweenTop = Math.min(fx, tx) + 20;
  const betweenBot = Math.max(fx, tx);
  for (let x = betweenTop; x <= betweenBot; x += 20) {
    searchOrder.push(x);
  }
  for (let x = betweenBot + 20; x <= betweenBot + 300; x += 20) {
    searchOrder.push(x);
  }

  for (const testX of searchOrder) {
    if (testX < minChannelX) continue;
    if (channelClear(testX, fy, ty)) {
      const hCrossesStart = horizontalCrossesVertical(fy, Math.min(fx, testX), Math.max(fx, testX), fromId);
      const hCrossesEnd = horizontalCrossesVertical(ty, Math.min(testX, tx), Math.max(testX, tx), fromId);
      if (!hCrossesStart && !hCrossesEnd) {
        return [{ x: fx, y: fy }, { x: testX, y: fy }, { x: testX, y: ty }, { x: tx, y: ty }];
      }
    }
  }

  return [{ x: fx, y: fy }, { x: preferredChannelX, y: fy }, { x: preferredChannelX, y: ty }, { x: tx, y: ty }];
}

export interface WireCrossing {
  wire1From: string;
  wire1To: string;
  wire2From: string;
  wire2To: string;
  x: number;
  y: number;
}

export function findWireCrossings(wires: LayoutWire[], junctions: LayoutJunction[]): WireCrossing[] {
  const crossings: WireCrossing[] = [];
  const junctionSet = new Set(junctions.map(j => `${Math.round(j.x)},${Math.round(j.y)}`));

  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      if (wires[i].fromId === wires[j].fromId) continue;
      for (let si = 0; si < wires[i].points.length - 1; si++) {
        for (let sj = 0; sj < wires[j].points.length - 1; sj++) {
          const a1 = wires[i].points[si], a2 = wires[i].points[si + 1];
          const b1 = wires[j].points[sj], b2 = wires[j].points[sj + 1];
          const aHoriz = Math.abs(a1.y - a2.y) < 1;
          const bVert = Math.abs(b1.x - b2.x) < 1;
          if (!aHoriz || !bVert) continue;
          const y = a1.y;
          const x = b1.x;
          const yMin = Math.min(b1.y, b2.y);
          const yMax = Math.max(b1.y, b2.y);
          const xMin = Math.min(a1.x, a2.x);
          const xMax = Math.max(a1.x, a2.x);
          if (y >= yMin - 1 && y <= yMax + 1 && x >= xMin - 1 && x <= xMax + 1) {
            const atJunction = junctionSet.has(`${Math.round(x)},${Math.round(y)}`);
            if (!atJunction) {
              crossings.push({
                wire1From: wires[i].fromId,
                wire1To: wires[i].toId,
                wire2From: wires[j].fromId,
                wire2To: wires[j].toId,
                x: Math.round(x),
                y: Math.round(y),
              });
            }
          }
        }
      }
    }
  }
  return crossings;
}

export { MIN_PORT_GAP, MIN_DOGLEG };
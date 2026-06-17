import type { LogicNode, GateNode, PortNode, Diagram, DiagramOutput, PortMeta, RenderOptions } from '../parser/ast.js';
import { DEFAULT_OPTIONS, resolveOptions } from '../parser/ast.js';
import { hasMathContent } from './math-renderer.js';
import { routeWireAStar, type GateObstacle, type RoutedSegment } from './astar-router.js';

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
const GATE_W_MULTI = 75;
const AND_GATE_H_BASE = 45;
const PORT_SPACING = 15;

const NOT_TRIANGLE_W = 50;

const BUBBLE_R = 5;
const NOT_GATE_TOTAL_W = NOT_TRIANGLE_W + BUBBLE_R * 2 + 5;
const NOT_GATE_H = 40;

const INPUT_LABEL_W = 90;
const OUTPUT_LABEL_W = 90;
const INPUT_STUB = 10;
const OUTPUT_STUB = 10;
const PORT_SIZE = 5;

const COL_SPACING = 260;
const ROW_SPACING = 80;
const PAD_X = 170;

const PAD_Y = 50;

const MIN_PORT_GAP = 25;
const MIN_DOGLEG = 30;
const MIN_WIRE_SPACING = 10;
const MIN_CHANNEL_SPACING = 20;
const WIRE_PAD = MIN_WIRE_SPACING / 2;
const BUBBLE_STUB = 5;
const GRID = 5;

let _id = 0;
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
  const exprMap = new Map<string, string>();

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
      const inputIds = node.inputs.map(i => resolve(i));
      // Canonical key for deduplication: sort inputs for commutative operators
      const keyInputIds = (node.gateType === 'AND' || node.gateType === 'OR')
        ? [...inputIds].sort()
        : inputIds;
      const key = `${node.gateType}(${keyInputIds.join(',')})`;
      const existing = exprMap.get(key);
      if (existing) return existing;

      const id = uid(node.gateType.toLowerCase());
      const depth = Math.max(...inputIds.map(iid => nodes.get(iid)?.depth ?? 0), 0) + 1;
      nodes.set(id, {
        id, kind: 'gate', gateType: node.gateType,
        depth, inputIds,
      });
      exprMap.set(key, id);
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

    // Build NOT chain info: for each NOT, walk to the ultimate non-NOT source
    // and record the cumulative inversion depth.
    const notChainInfo = new Map<string, { sourceId: string; inversionDepth: number }>();

    for (const notNode of notNodes) {
      if (notNode.inputIds.length !== 1) continue;
      let sourceId = notNode.inputIds[0];
      let depth = 1;

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

    // For each non-NOT node, walk each input through NOT chains to find
    // the ultimate source. Track inversion depth per input for bubble marking.
    const inputInversionDepth = new Map<string, Map<number, number>>();

    for (const otherNode of nodes.values()) {
      if (otherNode.kind === 'gate' && otherNode.gateType === 'NOT') continue;

      for (let i = 0; i < otherNode.inputIds.length; i++) {
        let ref = otherNode.inputIds[i];
        let totalInversion = 0;

        while (notChainInfo.has(ref)) {
          totalInversion += notChainInfo.get(ref)!.inversionDepth;
          otherNode.inputIds[i] = notChainInfo.get(ref)!.sourceId;
          ref = notChainInfo.get(ref)!.sourceId;
        }

        if (totalInversion > 0) {
          if (!inputInversionDepth.has(otherNode.id)) {
            inputInversionDepth.set(otherNode.id, new Map());
          }
          inputInversionDepth.get(otherNode.id)!.set(i, totalInversion);
        }
      }
    }

    // Mark bubbled inputs/outputs based on inversion depth
    // Odd inversion → bubble; even → cancel out
    for (const [nodeId, depthMap] of inputInversionDepth) {
      const node = nodes.get(nodeId);
      if (!node) continue;

      for (const [inputIdx, depth] of depthMap) {
        if (depth % 2 === 1) {
          const sourceId = node.inputIds[inputIdx];
          const sourceNode = nodes.get(sourceId);

          if (sourceNode && sourceNode.kind === 'gate' && sourceNode.gateType !== 'NOT') {
            // Source is a gate: output-side bubble on the source gate
            sourceNode.bubbledOutput = true;
          } else {
            // Source is an input port or output node: input-side bubble on this node
            if (!node.invertedInputs) node.invertedInputs = new Set();
            node.invertedInputs.add(inputIdx);
          }
        }
        // Even inversion: both NOTs cancel, no bubble needed
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

  // Push outputs to a higher depth if they share a column with any gate node.
  // This prevents wires from passing through intermediate gate bodies when an
  // output's depth column coincides with a gate's (e.g. when a shared subexpression
  // feeds both a multi-input gate and a direct output).
  {
    const maxCheckDepth = Math.max(...Array.from(nodes.values()).map(n => n.depth), 0) + 5;
    for (let depth = 0; depth <= maxCheckDepth; depth++) {
      const hasGate = Array.from(nodes.values()).some(n => n.kind === 'gate' && n.depth === depth);
      if (!hasGate) continue;
      for (const node of nodes.values()) {
        if (node.kind === 'output' && node.depth === depth) {
          node.depth++;
        }
      }
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
      h = node.description ? 30 : 20;
      if (node.name && hasMathContent(node.name)) h = Math.max(h, 30);
      if (node.description && hasMathContent(node.description)) h = Math.max(h, 30);
      h = Math.ceil(h / 10) * 10;
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
      h = node.description ? 30 : 20;
      if (node.name && hasMathContent(node.name)) h = Math.max(h, 30);
      if (node.description && hasMathContent(node.description)) h = Math.max(h, 30);
      h = Math.ceil(h / 10) * 10;
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
        h = Math.max(AND_GATE_H_BASE, (numInputs + 1) * PORT_SPACING);
        w = isMultiInput ? GATE_W_MULTI : GATE_W;
      }

      const inputs: LayoutPort[] = [];
      if (useBars) {
        const portSpacing = Math.round(h / 3 / GRID) * GRID;
        for (let i = 0; i < Math.min(2, numInputs); i++) {
          const portY = absY + (i + 1) * portSpacing;
          inputs.push({ name: `in_${i}`, absX: absX, absY: portY });
        }
        for (let i = 2; i < numInputs; i++) {
          const spacing = (h - 2 * AND_GATE_H_BASE / 3) / (numInputs - 1);
          const portY = absY + AND_GATE_H_BASE / 3 + (i - 2) * Math.min(spacing, MIN_PORT_GAP);
          const snappedY = Math.round(portY / GRID) * GRID;
          inputs.push({ name: `in_${i}`, absX: absX - 10, absY: snappedY });
        }
} else {
      for (let i = 0; i < numInputs; i++) {
        const portY = absY + (i + 1) * PORT_SPACING;
        inputs.push({ name: `in_${i}`, absX: absX, absY: portY });
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

      const gateCenterY = Math.round((absY + h / 2) / GRID) * GRID;
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
        const shift = Math.round((inputBottom - gateTop + 5) / GRID) * GRID;
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
    const sourceOutputY = Math.round(sourceNode.outputs[0].absY / GRID) * GRID;
    const offsetY = sourceOutputY - gateNode.inputs[0].absY;
    gateNode.absY = Math.round((gateNode.absY + offsetY) / GRID) * GRID;
    gateNode.inputs[0].absY = sourceOutputY;
    if (gateNode.outputs.length > 0) {
      gateNode.outputs[0].absY = Math.round((gateNode.absY + gateNode.height / 2) / GRID) * GRID;
    }
  }

  for (const node of nodes.values()) {
    if (node.kind !== 'output') continue;
    const outputNode = nodeMap.get(node.id);
    if (!outputNode || node.inputIds.length === 0) continue;
    const sourceId = node.inputIds[0];
    const sourceNode = nodeMap.get(sourceId);
    if (!sourceNode || sourceNode.outputs.length === 0) continue;
    const sourceOutputY = Math.round(sourceNode.outputs[0].absY / GRID) * GRID;
    outputNode.inputs[0].absY = sourceOutputY;
    outputNode.absY = Math.round((sourceOutputY - outputNode.height / 2) / GRID) * GRID;
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
      gateNode.absY = Math.round(requiredTop / GRID) * GRID;
      gateNode.height = Math.ceil(requiredHeight / GRID) * GRID;
      for (let i = 0; i < indexed.length && i < gateNode.inputs.length; i++) {
        gateNode.inputs[i].absY = Math.round(idealYs[i] / GRID) * GRID;
      }
      if (gateNode.outputs.length > 0) {
        gateNode.outputs[0].absY = Math.round((gateNode.absY + gateNode.height / 2) / GRID) * GRID;
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
    for (let delta = -MIN_DOGLEG; delta <= MIN_DOGLEG; delta += GRID) {
      const score = smallDoglegScore(delta);
      if (score < bestScore || (score === bestScore && Math.abs(delta) < Math.abs(bestDelta))) {
        bestScore = score;
        bestDelta = delta;
      }
    }

    if (Math.abs(bestDelta) >= GRID) {
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
      gateNode.absY = Math.round(requiredTop / GRID) * GRID;
      gateNode.height = Math.ceil(requiredHeight / GRID) * GRID;
      for (let i = 0; i < indexed.length && i < gateNode.inputs.length; i++) {
        gateNode.inputs[i].absY = Math.round(idealYs[i] / GRID) * GRID;
      }
      if (gateNode.outputs.length > 0) {
        gateNode.outputs[0].absY = Math.round((gateNode.absY + gateNode.height / 2) / GRID) * GRID;
      }
    } else {
      const currentYs = gateNode.inputs.map(p => p.absY);
      for (let i = 0; i < sourceYs.length && i < gateNode.inputs.length; i++) {
        const diff = Math.abs(sourceYs[i] - currentYs[i]);
        if (diff >= 1 && diff < MIN_DOGLEG) {
          const candidateY = Math.round(sourceYs[i] / GRID) * GRID;
          const prevY = i > 0 ? gateNode.inputs[i - 1].absY : gateNode.absY;
          const nextY = i < gateNode.inputs.length - 1 ? gateNode.inputs[i + 1].absY : gateNode.absY + gateNode.height;
          if (candidateY - prevY >= MIN_PORT_GAP && nextY - candidateY >= MIN_PORT_GAP) {
            gateNode.inputs[i].absY = candidateY;
          } else {
            if (candidateY > currentYs[i]) {
              gateNode.inputs[i].absY = Math.round((sourceYs[i] + MIN_DOGLEG) / GRID) * GRID;
            } else {
              gateNode.inputs[i].absY = Math.round((sourceYs[i] - MIN_DOGLEG) / GRID) * GRID;
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
    const sourceOutputY = Math.round(sourceNode.outputs[0].absY / GRID) * GRID;
    outputNode.inputs[0].absY = sourceOutputY;
    outputNode.absY = Math.round((sourceOutputY - outputNode.height / 2) / GRID) * GRID;
  }

  // Resolve gate-gate overlaps at the same depth column by pushing the lower
  // gate down so their bounding boxes no longer intersect.
  for (let pass = 0; pass < 5; pass++) {
    let anyOverlap = false;
    // Gates vs gates
    for (let i = 0; i < layoutNodes.length; i++) {
      const a = layoutNodes[i];
      if (a.gateType === 'INPUT' || a.gateType === 'OUTPUT') continue;
      for (let j = i + 1; j < layoutNodes.length; j++) {
        const b = layoutNodes[j];
        if (b.gateType === 'INPUT' || b.gateType === 'OUTPUT') continue;
        if (a.depth !== b.depth) continue;
        const xOverlap = Math.min(a.absX + a.width, b.absX + b.width) - Math.max(a.absX, b.absX);
        if (xOverlap <= 0) continue;
        const yOverlap = Math.min(a.absY + a.height, b.absY + b.height) - Math.max(a.absY, b.absY);
        if (yOverlap <= 0) continue;
        const shift = Math.round((yOverlap + MIN_PORT_GAP) / GRID) * GRID;
        if (a.absY < b.absY) {
          b.absY += shift;
          for (const port of b.inputs) port.absY += shift;
          for (const port of b.outputs) port.absY += shift;
        } else {
          a.absY += shift;
          for (const port of a.inputs) port.absY += shift;
          for (const port of a.outputs) port.absY += shift;
        }
        anyOverlap = true;
      }
    }
    // Gates vs outputs
    for (const node of layoutNodes) {
      if (node.gateType === 'INPUT') continue;
      if (node.gateType !== 'OUTPUT') continue;
      for (const gate of layoutNodes) {
        if (gate.gateType === 'INPUT' || gate.gateType === 'OUTPUT') continue;
        if (node.depth !== gate.depth) continue;
        const xOverlap = Math.min(node.absX + node.width, gate.absX + gate.width) - Math.max(node.absX, gate.absX);
        if (xOverlap <= 0) continue;
        const yOverlap = Math.min(node.absY + node.height, gate.absY + gate.height) - Math.max(node.absY, gate.absY);
        if (yOverlap <= 0) continue;
        const shift = Math.round((yOverlap + MIN_PORT_GAP) / GRID) * GRID;
        if (gate.absY < node.absY) {
          node.absY += shift;
          node.inputs[0].absY += shift;
        } else {
          gate.absY += shift;
          for (const port of gate.inputs) port.absY += shift;
          for (const port of gate.outputs) port.absY += shift;
        }
        anyOverlap = true;
      }
    }
    if (!anyOverlap) break;
  }

  // Re-align output nodes after gate collision resolution
  for (const node of nodes.values()) {
    if (node.kind !== 'output') continue;
    const outputNode = nodeMap.get(node.id);
    if (!outputNode || node.inputIds.length === 0) continue;
    const sourceId = node.inputIds[0];
    const sourceNode = nodeMap.get(sourceId);
    if (!sourceNode || sourceNode.outputs.length === 0) continue;
    const sourceOutputY = Math.round(sourceNode.outputs[0].absY / GRID) * GRID;
    outputNode.inputs[0].absY = sourceOutputY;
    outputNode.absY = Math.round((sourceOutputY - outputNode.height / 2) / GRID) * GRID;
  }

  // Resolve output-vs-output overlaps at the same depth column.
  // Two outputs in the same column can overlap in Y because their source
  // gate output ports are close together. Push the lower output down.
  for (let pass = 0; pass < 5; pass++) {
    let anyOverlap = false;
    const outputNodes = layoutNodes.filter(n => n.gateType === 'OUTPUT');
    for (let i = 0; i < outputNodes.length; i++) {
      for (let j = i + 1; j < outputNodes.length; j++) {
        const a = outputNodes[i], b = outputNodes[j];
        if (a.depth !== b.depth) continue;
        const xOverlap = Math.min(a.absX + a.width, b.absX + b.width) - Math.max(a.absX, b.absX);
        if (xOverlap <= 0) continue;
        const yOverlap = Math.min(a.absY + a.height, b.absY + b.height) - Math.max(a.absY, b.absY);
        if (yOverlap <= 0) continue;
        const shift = Math.round((yOverlap + MIN_PORT_GAP) / GRID) * GRID;
        if (a.absY < b.absY) {
          b.absY += shift;
          b.inputs[0].absY += shift;
        } else {
          a.absY += shift;
          a.inputs[0].absY += shift;
        }
        anyOverlap = true;
      }
    }
    if (!anyOverlap) break;
  }

  const wires: LayoutWire[] = [];
  const junctions: LayoutJunction[] = [];
  const junctionSet = new Set<string>();

  function addJunction(x: number, y: number) {
    const key = `${Math.round(x / GRID) * GRID},${Math.round(y / GRID) * GRID}`;
    if (!junctionSet.has(key)) {
      junctionSet.add(key);
      junctions.push({ x: Math.round(x / GRID) * GRID, y: Math.round(y / GRID) * GRID });
    }
  }

  const allObstacles: GateObstacle[] = layoutNodes.map(n => ({ x: n.absX, y: n.absY, w: n.width, h: n.height, id: n.id }));

  const routedSegments: RoutedSegment[] = [];

  const canvasW = Math.max(...layoutNodes.map(n => n.absX + n.width), ...layoutNodes.map(n => n.outputs[0]?.absX ?? n.absX + n.width)) + 200;
  const canvasH = Math.max(...layoutNodes.map(n => n.absY + n.height)) + 200;

  // Build fan-out groups: destinations per source
  const fanOutGroups = new Map<string, { toId: string; toPort: LayoutPort; toLayoutNode: LayoutNode; destIsGate: boolean }[]>();

  const wireRoutingOrder = Array.from(nodes.values()).sort((a, b) => a.depth - b.depth);
  for (const node of wireRoutingOrder) {
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

    for (let i = 0; i < sortedInputIds.length; i++) {
      const fromId = sortedInputIds[i];
      const toPortIdx = Math.min(i, toLayoutNode.inputs.length - 1);
      const toPort = toLayoutNode.inputs[toPortIdx];
      if (!toPort) continue;
      const destIsGate = node.kind === 'gate';

      if (!fanOutGroups.has(fromId)) {
        fanOutGroups.set(fromId, []);
      }
      fanOutGroups.get(fromId)!.push({ toId: node.id, toPort, toLayoutNode, destIsGate });
    }
  }

  // Route wires: fan-out groups with shared trunks, single destinations normally
  for (const [fromId, destinations] of fanOutGroups) {
    const fromLayoutNode = nodeMap.get(fromId);
    if (!fromLayoutNode || !fromLayoutNode.outputs[0]) continue;
    const fromPort = fromLayoutNode.outputs[0];
    const fx = fromPort.absX;
    const fy = fromPort.absY;

    if (destinations.length >= 2) {
      // Fan-out: route shared trunk then branches
      destinations.sort((a, b) => a.toPort.absY - b.toPort.absY);

      // Compute branch X: midpoint between source column and closest destination column
      const minDestX = Math.min(...destinations.map(d => d.toPort.absX));
      const branchX = Math.round((fx + minDestX) / 2 / GRID) * GRID;

      // Route trunk: simple horizontal from source to branch point
      const trunkPoints: { x: number; y: number }[] = [
        { x: fx, y: fy },
        { x: branchX, y: fy },
      ];
      routedSegments.push({ points: trunkPoints, fromId });

      // For each destination, route a branch from (branchX, fy) to destination
      for (let di = 0; di < destinations.length; di++) {
        const dest = destinations[di];
        const tx = dest.toPort.absX;
        const ty = dest.toPort.absY;
        const destIsGate = dest.destIsGate;

        // If source and destination are at the same Y, route directly (no dogleg needed)
        if (Math.abs(fy - ty) < 1) {
          const directPoints = routeWireAStar(
            fx, fy, tx, ty,
            allObstacles,
            fromLayoutNode.absX, fromLayoutNode.absY,
            fromLayoutNode.width, fromLayoutNode.height,
            dest.toLayoutNode.absX, dest.toLayoutNode.absY,
            dest.toLayoutNode.width, dest.toLayoutNode.height,
            destIsGate,
            routedSegments,
            canvasW, canvasH,
            fromId,
          );
          routedSegments.push({ points: directPoints, fromId });
          wires.push({
            id: uid('wire'),
            points: directPoints,
            fromId,
            toId: dest.toId,
          });
          // Also add trunk segment for this fan-out wire so it shares the trunk visually
          // The trunk goes from source to branchX at source Y
          if (destinations.length > 1) {
            addJunction(branchX, fy);
          }
          continue;
        }

        const branchPoints = routeWireAStar(
          branchX, fy, tx, ty,
          allObstacles,
          fromLayoutNode.absX, fromLayoutNode.absY,
          fromLayoutNode.width, fromLayoutNode.height,
          dest.toLayoutNode.absX, dest.toLayoutNode.absY,
          dest.toLayoutNode.width, dest.toLayoutNode.height,
          destIsGate,
          routedSegments,
          canvasW, canvasH,
          fromId,
        );

        routedSegments.push({ points: branchPoints, fromId });

        // Combine trunk + branch, inserting correction point at junction if needed
        // to ensure orthogonality between the horizontal trunk and the branch's first segment
        let combinedPoints: { x: number; y: number }[];
        if (branchPoints.length >= 2 && Math.abs(branchPoints[1].y - fy) >= 1) {
          // Branch goes vertical after the junction: insert an L-shaped correction
          // trunk: (..., branchX, fy) -> (branchX, branchNext.y) if vertical, or
          // trunk: (..., branchX, fy) -> (branchNext.x, fy) -> (branchNext.x, branchNext.y) if horizontal first
          const branchNext = branchPoints[1];
          if (Math.abs(branchNext.x - branchX) >= 1) {
            // Branch first segment goes at an angle — insert correction
            // Go horizontal to branchNext.x, then connect to rest of branch
            combinedPoints = [...trunkPoints, { x: branchNext.x, y: fy }, ...branchPoints.slice(1)];
          } else {
            // Branch goes purely vertical from branch point — direct connection
            combinedPoints = [...trunkPoints, ...branchPoints.slice(1)];
          }
        } else {
          // Branch starts horizontal or is a straight line — direct connection
          combinedPoints = [...trunkPoints, ...branchPoints.slice(1)];
        }

        wires.push({
          id: uid('wire'),
          points: combinedPoints,
          fromId,
          toId: dest.toId,
        });
      }

      // Junction dot at the branch point
      addJunction(branchX, fy);
    } else {
      // Single destination: route normally
      const dest = destinations[0];
      const tx = dest.toPort.absX;
      const ty = dest.toPort.absY;

      const points = routeWireAStar(
        fx, fy, tx, ty,
        allObstacles,
        fromLayoutNode.absX, fromLayoutNode.absY,
        fromLayoutNode.width, fromLayoutNode.height,
        dest.toLayoutNode.absX, dest.toLayoutNode.absY,
        dest.toLayoutNode.width, dest.toLayoutNode.height,
        dest.destIsGate,
        routedSegments,
        canvasW, canvasH,
        fromId,
      );

      routedSegments.push({ points, fromId });

      wires.push({
        id: uid('wire'),
        points,
        fromId,
        toId: dest.toId,
      });
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

  // Snap all positions to the GRID so A* routing produces clean orthogonal paths
  for (const n of layoutNodes) {
    n.absX = Math.round(n.absX / GRID) * GRID;
    n.absY = Math.round(n.absY / GRID) * GRID;
    for (const p of n.inputs) {
      p.absX = Math.round(p.absX / GRID) * GRID;
      p.absY = Math.round(p.absY / GRID) * GRID;
    }
    for (const p of n.outputs) {
      p.absX = Math.round(p.absX / GRID) * GRID;
      p.absY = Math.round(p.absY / GRID) * GRID;
    }
  }
  for (const w of wires) {
    for (const p of w.points) {
      p.x = Math.round(p.x / GRID) * GRID;
      p.y = Math.round(p.y / GRID) * GRID;
    }
  }
  for (const j of junctions) {
    j.x = Math.round(j.x / GRID) * GRID;
    j.y = Math.round(j.y / GRID) * GRID;
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
import type { Diagram, PortMeta, RenderOptions } from '../parser/ast.js';
import { DEFAULT_OPTIONS, resolveOptions } from '../parser/ast.js';
import { layoutDiagram } from './layout.js';
import type { LayoutNode, LayoutPort } from './layout.js';
import {
  andGateBody, orGateBody, notGateBody,
  renderPortSquare, renderInputPortLabel, renderOutputPortLabel, renderJunctionDot,
  GATE_W, GATE_W_MULTI, NOT_TRIANGLE_W, BUBBLE_R, NOT_GATE_TOTAL_W, NOT_GATE_H,
  STROKE_COLOR, FILL_COLOR, WIRE_COLOR, PORT_SIZE,
} from './gates.js';
import { renderWire } from './wires.js';

const INPUT_BAR_OFFSET = 12;
const INPUT_BAR_STUB = 6;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderDiagram(diagram: Diagram, portMeta?: PortMeta[], showLabels: boolean = true, showIds: boolean = false, options?: RenderOptions): string {
  const opts = options ?? DEFAULT_OPTIONS;
  const layout = layoutDiagram(diagram, portMeta, opts);

  const svgWires: string[] = [];
  const svgBodies: string[] = [];
  const svgPorts: string[] = [];
  const svgJunctions: string[] = [];
  const svgIds: string[] = [];
  const svgLabels: string[] = [];

  for (const wire of layout.wires) {
    svgWires.push(renderWire(wire.points, wire.fromId, wire.toId));
  }

  for (const node of layout.nodes) {
    renderNodeBody(node, svgBodies, layout.options);
    renderNodePorts(node, svgPorts, layout.options);
    renderNodeLabels(node, showLabels, svgLabels);
    renderNodeIds(node, showIds, svgIds);
  }

  for (const junction of layout.junctions) {
    svgJunctions.push(renderJunctionDot(junction.x, junction.y));
  }

  const pad = 30;
  const svgW = layout.width + pad * 2;
  const svgH = layout.height + pad * 2;

  const labelsClass = showLabels ? 'ldl-show-labels' : '';
  const idsClass = showIds ? 'ldl-show-ids' : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" class="ldl-diagram ${labelsClass} ${idsClass}" style="max-width:100%;max-height:100%;">
  <defs>
    <style>
      .ldl-wire { stroke: ${WIRE_COLOR}; fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; transition: stroke 0.2s; }
      .ldl-wire:hover { stroke: #1b5e20; stroke-width: 3.5; }
      .ldl-symbol:hover { filter: brightness(1.3); }
      .ldl-input-port text { fill: #1a237e; }
      .ldl-output-port text { fill: #1a237e; }
      .ldl-port { transition: filter 0.15s; }
      .ldl-port:hover { filter: brightness(1.5); }
      .ldl-diagram:not(.ldl-show-labels) .ldl-label { display: none; }
      .ldl-diagram:not(.ldl-show-ids) .ldl-id { display: none; }
      .ldl-diagram.ldl-show-labels .ldl-label { display: block; }
      .ldl-diagram.ldl-show-ids .ldl-id { display: block; }
    </style>
  </defs>
  <rect x="0" y="0" width="${svgW}" height="${svgH}" fill="#ffffff" rx="4"/>
  <g transform="translate(${pad}, ${pad})">
    ${svgWires.join('\n    ')}
    ${svgBodies.join('\n    ')}
    ${svgPorts.join('\n    ')}
    ${svgJunctions.join('\n    ')}
    ${svgIds.join('\n    ')}
    ${svgLabels.join('\n    ')}
  </g>
</svg>`;
}

function renderNodeBody(node: LayoutNode, bodies: string[], opts: RenderOptions): void {
  if (opts.inversion === 'BUBBLES' && node.gateType === 'NOT') {
    return;
  }
  switch (node.gateType) {
    case 'INPUT':
      renderInputNodeBody(node, bodies);
      break;
    case 'OUTPUT':
      renderOutputNodeBody(node, bodies);
      break;
    case 'AND':
      renderGateNodeBody(node, 'and', '&', bodies);
      break;
    case 'OR':
      renderGateNodeBody(node, 'or', '\u22651', bodies);
      break;
    case 'NOT':
      renderNotNodeBody(node, bodies);
      break;
    default:
      renderGateNodeBody(node, 'and', '&', bodies);
  }
}

function renderNodePorts(node: LayoutNode, ports: string[], opts: RenderOptions): void {
  if (node.gateType === 'INPUT') {
    const port = node.outputs[0];
    if (port) {
      ports.push(renderPort(port.absX, port.absY, port, 'out', 'output', opts));
    }
  } else if (node.gateType === 'OUTPUT') {
    const port = node.inputs[0];
    if (port) {
      if (port.bubbled) {
        // Output node with bubbled input: bubble between wire endpoint and output port
        // Port absX was shifted left by BUBBLE_R*2; bubble right edge touches output port's natural position
        const bubbleCenterX = port.absX + BUBBLE_R;
        ports.push(`<circle class="ldl-bubble ldl-input" data-port="${esc(port.name)}" cx="${bubbleCenterX}" cy="${port.absY}" r="${BUBBLE_R}" fill="${FILL_COLOR}" stroke="${STROKE_COLOR}" stroke-width="1.5"/>`);
      } else {
        ports.push(renderPort(port.absX, port.absY, port, 'in', 'input', opts));
      }
    }
  } else {
    for (const p of node.inputs) {
      if (p.bubbled) {
        // Input-side bubble: Port absX = gate edge - BUBBLE_R*2
        // Wire ends at p.absX (= bubble left edge), bubble center at p.absX + BUBBLE_R,
        // bubble right edge at p.absX + BUBBLE_R*2 (= gate edge).
        const bubbleCenterX = p.absX + BUBBLE_R;
        ports.push(`<circle class="ldl-bubble ldl-input" data-port="${esc(p.name)}" cx="${bubbleCenterX}" cy="${p.absY}" r="${BUBBLE_R}" fill="${FILL_COLOR}" stroke="${STROKE_COLOR}" stroke-width="1.5"/>`);
      } else {
        ports.push(renderPort(p.absX, p.absY, p, p.name, 'input', opts));
      }
    }
    if (node.outputs.length > 0) {
      const p = node.outputs[0];
      if (p.bubbledOutput) {
        // Output-side bubble: Port absX was shifted right by BUBBLE_R*2 from gate edge
        // Bubble center at (gate edge + BUBBLE_R), wire starts at (gate edge + BUBBLE_R*2) = p.absX
        const gateEdgeX = p.absX - BUBBLE_R * 2;
        const bubbleCenterX = gateEdgeX + BUBBLE_R;
        ports.push(`<circle class="ldl-bubble ldl-output" data-port="${esc(p.name)}" cx="${bubbleCenterX}" cy="${p.absY}" r="${BUBBLE_R}" fill="${FILL_COLOR}" stroke="${STROKE_COLOR}" stroke-width="1.5"/>`);
      } else {
        ports.push(renderPort(p.absX, p.absY, p, p.name, 'output', opts));
      }
    }
  }
}

function renderPort(x: number, y: number, port: LayoutPort, name: string, direction: 'input' | 'output', opts: RenderOptions): string {
  const style = port.style ?? opts.portStyle;
  const dirClass = direction === 'input' ? 'ldl-input' : 'ldl-output';
  if (style === 'SQUARE') {
    const size = PORT_SIZE;
    return `<rect class="ldl-port ${dirClass} ldl-port-square" data-port="${esc(name)}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" fill="${STROKE_COLOR}"/>`;
  }
  return `<circle class="ldl-port ${dirClass} ldl-port-circle" data-port="${esc(name)}" cx="${x}" cy="${y}" r="${3}" fill="${STROKE_COLOR}"/>`;
}

function renderNodeLabels(node: LayoutNode, showLabels: boolean, labels: string[]): void {
  if (node.gateType === 'INPUT') {
    const port = node.outputs[0];
    if (port) {
      const labelRight = node.absX + node.width - 10;
      labels.push(renderInputPortLabel(labelRight, port.absY, node.label ?? '', node.name, node.description));
    }
  } else if (node.gateType === 'OUTPUT') {
    const port = node.inputs[0];
    if (port) {
      const labelLeft = port.absX + 10;
      labels.push(renderOutputPortLabel(labelLeft, port.absY, node.label ?? '', node.name, node.description));
    }
  }
}

function renderNodeIds(node: LayoutNode, showIds: boolean, ids: string[]): void {
  if (!showIds) return;
  if (node.gateType === 'INPUT') {
    const port = node.outputs[0];
    if (port) {
      ids.push(`<text class="ldl-id" x="${port.absX + PORT_SIZE / 2 + 3}" y="${port.absY + 3}" text-anchor="start" fill="#90a4ae" font-size="10" font-family="sans-serif" font-weight="600">${esc(node.label ?? '')}</text>`);
    }
  } else if (node.gateType === 'OUTPUT') {
    const port = node.inputs[0];
    if (port) {
      ids.push(`<text class="ldl-id" x="${port.absX - PORT_SIZE / 2 - 3}" y="${port.absY + 3}" text-anchor="end" fill="#90a4ae" font-size="10" font-family="sans-serif" font-weight="600">${esc(node.label ?? '')}</text>`);
    }
  } else {
    for (const p of node.inputs) {
      ids.push(`<text class="ldl-id" x="${p.absX - PORT_SIZE / 2 - 3}" y="${p.absY + 3}" text-anchor="end" fill="#90a4ae" font-size="10" font-family="sans-serif" font-weight="600">${esc(p.name)}</text>`);
    }
    if (node.outputs.length > 0) {
      const p = node.outputs[0];
      ids.push(`<text class="ldl-id" x="${p.absX + PORT_SIZE / 2 + 3}" y="${p.absY + 3}" text-anchor="start" fill="#90a4ae" font-size="10" font-family="sans-serif" font-weight="600">out</text>`);
    }
  }
}

function renderInputNodeBody(node: LayoutNode, bodies: string[]): void {
  const port = node.outputs[0];
  if (!port) return;

  const labelRight = node.absX + node.width - 10;
  bodies.push(`<line class="ldl-wire" x1="${labelRight}" y1="${port.absY}" x2="${port.absX}" y2="${port.absY}"/>`);
}

function renderOutputNodeBody(node: LayoutNode, bodies: string[]): void {
  const port = node.inputs[0];
  if (!port) return;

  const labelLeft = port.absX + 10;
  bodies.push(`<line class="ldl-wire" x1="${port.absX}" y1="${port.absY}" x2="${labelLeft}" y2="${port.absY}"/>`);
}

function renderGateNodeBody(node: LayoutNode, shape: 'and' | 'or', symbol: string, bodies: string[]): void {
  const w = node.width;
  const h = node.height;
  const x = node.absX;
  const y = node.absY;

  let bodyPath: string;
  if (shape === 'or') {
    bodyPath = orGateBody(w, h);
  } else {
    bodyPath = andGateBody(w, h);
  }

  const cls = shape === 'or' ? 'ldl-gate-or' : 'ldl-gate-and';
  const fontSize = Math.min(20, Math.max(12, h * 0.22));

  const parts: string[] = [];
  parts.push(`<g class="ldl-symbol ${cls}" id="${esc(node.id)}">`);
  parts.push(`  <path d="${bodyPath}" transform="translate(${x}, ${y})" fill="${FILL_COLOR}" stroke="${STROKE_COLOR}" stroke-width="2.5"/>`);
  parts.push(`  <text x="${x + w / 2}" y="${y + h / 2 + fontSize * 0.35}" text-anchor="middle" fill="${STROKE_COLOR}" font-size="${fontSize}" font-weight="700" font-family="sans-serif">${esc(symbol)}</text>`);

  if (node.barsMode && node.inputs.length > 2) {
    const barX = x - INPUT_BAR_OFFSET;
    parts.push(`  <line class="ldl-input-bar" x1="${barX}" y1="${y}" x2="${barX}" y2="${y + h}" stroke="${STROKE_COLOR}" stroke-width="2.5"/>`);
    for (let i = 2; i < node.inputs.length; i++) {
      const port = node.inputs[i];
      const stubEnd = x - INPUT_BAR_STUB;
      parts.push(`  <line class="ldl-bar-stub" x1="${barX}" y1="${port.absY}" x2="${stubEnd}" y2="${port.absY}" stroke="${WIRE_COLOR}" stroke-width="2.5"/>`);
    }
  }

  parts.push('</g>');

  bodies.push(parts.join('\n'));
}

function renderNotNodeBody(node: LayoutNode, bodies: string[]): void {
  const x = node.absX;
  const y = node.absY;
  const h = NOT_GATE_H;

  const bodyPath = notGateBody(NOT_TRIANGLE_W, h);

  const parts: string[] = [];
  parts.push(`<g class="ldl-symbol ldl-gate-not" id="${esc(node.id)}">`);
  parts.push(`  <path d="${bodyPath}" transform="translate(${x}, ${y})" fill="${FILL_COLOR}" stroke="${STROKE_COLOR}" stroke-width="2.5"/>`);
  parts.push(`  <circle cx="${x + NOT_TRIANGLE_W + BUBBLE_R}" cy="${y + h / 2}" r="${BUBBLE_R}" fill="${FILL_COLOR}" stroke="${STROKE_COLOR}" stroke-width="2.5"/>`);
  parts.push(`  <text x="${x + NOT_TRIANGLE_W * 0.38}" y="${y + h / 2 + 4}" text-anchor="middle" fill="${STROKE_COLOR}" font-size="11" font-weight="700" font-family="sans-serif">NOT</text>`);

  if (node.outputs.length > 0) {
    const outPort = node.outputs[0];
    const stubStartX = x + NOT_TRIANGLE_W + BUBBLE_R * 2;
    parts.push(`  <line class="ldl-wire" x1="${stubStartX}" y1="${y + h / 2}" x2="${outPort.absX}" y2="${y + h / 2}"/>`);
  }

  parts.push('</g>');

  bodies.push(parts.join('\n'));
}
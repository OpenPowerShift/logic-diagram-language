import type { Diagram, PortMeta, RenderOptions } from '../parser/ast.js';
import { DEFAULT_OPTIONS, resolveOptions } from '../parser/ast.js';
import { layoutDiagram } from './layout.js';
import type { LayoutNode, LayoutPort } from './layout.js';
import {
  andGateBody, orGateBody, notGateBody,
  renderInputPortLabel, renderOutputPortLabel, renderJunctionDot,
  GATE_W, GATE_W_MULTI, NOT_TRIANGLE_W, BUBBLE_R, NOT_GATE_TOTAL_W, NOT_GATE_H,
  PORT_SIZE,
} from './gates.js';
import type { DiagramTheme } from '../theme/themes.js';
import { LIGHT_DIAGRAM } from '../theme/themes.js';
import { renderWire } from './wires.js';
import { hasMathContent, splitIntoSegments, renderMath, estimateTextWidth } from './math-renderer.js';

const INPUT_BAR_OFFSET = 10;
const INPUT_BAR_STUB = 5;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderDiagram(diagram: Diagram, portMeta?: PortMeta[], showLabels: boolean = true, showIds: boolean = false, options?: RenderOptions, diagramTheme?: DiagramTheme): string {
  const opts = options ?? DEFAULT_OPTIONS;
  const theme = diagramTheme ?? LIGHT_DIAGRAM;
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
    renderNodeBody(node, svgBodies, layout.options, theme);
    renderNodePorts(node, svgPorts, layout.options, theme);
    renderNodeLabels(node, showLabels, svgLabels, theme);
    renderNodeIds(node, showIds, svgIds, theme);
  }

  for (const junction of layout.junctions) {
    svgJunctions.push(renderJunctionDot(junction.x, junction.y, theme));
  }

  // Content bounds include port label text, which can extend past the node bounding boxes
  // (long output names overflow to the right, long input names to the left). Without this
  // the viewBox clips them — the cause of right-side truncation in SVG/PDF export.
  let minX = 0, maxX = layout.width, minY = 0, maxY = layout.height;
  for (const node of layout.nodes) {
    if (node.gateType === 'INPUT' && node.outputs[0]) {
      const w = labelExtent(node, showLabels, showIds);
      const p = node.outputs[0];
      if (w > 0) minX = Math.min(minX, p.absX - 16 - w);
      minY = Math.min(minY, p.absY - 18);
      maxY = Math.max(maxY, p.absY + 18);
    } else if (node.gateType === 'OUTPUT' && node.inputs[0]) {
      const w = labelExtent(node, showLabels, showIds);
      const p = node.inputs[0];
      if (w > 0) maxX = Math.max(maxX, p.absX + 16 + w);
      minY = Math.min(minY, p.absY - 18);
      maxY = Math.max(maxY, p.absY + 18);
    }
  }

  const pad = 30;
  const svgW = (maxX - minX) + pad * 2;
  const svgH = (maxY - minY) + pad * 2;
  const tx = pad - minX;
  const ty = pad - minY;

  const labelsClass = showLabels ? 'ldl-show-labels' : '';
  const idsClass = showIds ? 'ldl-show-ids' : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" class="ldl-diagram ${labelsClass} ${idsClass}" style="max-width:100%;max-height:100%;">
  <defs>
    <style>
      .ldl-wire { stroke: ${theme.wire}; fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; transition: stroke 0.2s; }
      .ldl-wire:hover { stroke: ${theme.wireHover}; stroke-width: 3.5; }
      .ldl-symbol:hover { filter: brightness(1.3); }
      .ldl-input-port text { fill: ${theme.nameFill}; }
      .ldl-output-port text { fill: ${theme.nameOutFill}; }
      .ldl-port { transition: filter 0.15s; }
      .ldl-port:hover { filter: brightness(1.5); }
      .ldl-diagram:not(.ldl-show-labels) .ldl-label { display: none; }
      .ldl-diagram:not(.ldl-show-ids) .ldl-id { display: none; }
      .ldl-diagram.ldl-show-labels .ldl-label { display: block; }
      .ldl-diagram.ldl-show-ids .ldl-id { display: block; }
    </style>
  </defs>
  <rect x="0" y="0" width="${svgW}" height="${svgH}" fill="${theme.background}" rx="4"/>
  <g transform="translate(${tx}, ${ty})">
    ${svgWires.join('\n    ')}
    ${svgBodies.join('\n    ')}
    ${svgPorts.join('\n    ')}
    ${svgJunctions.join('\n    ')}
    ${svgIds.join('\n    ')}
    ${svgLabels.join('\n    ')}
  </g>
</svg>`;
}

// Widest rendered line of a port label (name/description/id), used to size the viewBox so
// labels are never clipped. Handles mixed plain + math (TeX) content.
function textLineWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const seg of splitIntoSegments(text)) {
    if (seg.type === 'math') {
      const r = renderMath(seg.text, fontSize);
      w += r?.width ?? estimateTextWidth(seg.text, fontSize);
    } else {
      w += estimateTextWidth(seg.text, fontSize);
    }
  }
  return w;
}

function labelExtent(node: LayoutNode, showLabels: boolean, showIds: boolean): number {
  let w = 0;
  if (showLabels) {
    const name = node.name || node.label || '';
    w = Math.max(w, textLineWidth(name, 12));
    if (node.description) w = Math.max(w, textLineWidth(node.description, 9));
  }
  if (showIds) w = Math.max(w, textLineWidth(node.label || '', 10));
  // Safety margin: names render in a semi-bold weight that the width estimate undershoots,
  // so pad generously to guarantee the label is never clipped.
  return w > 0 ? w * 1.15 + 10 : 0;
}

function renderNodeBody(node: LayoutNode, bodies: string[], opts: RenderOptions, theme: DiagramTheme): void {
  if (opts.inversion === 'BUBBLES' && node.gateType === 'NOT') {
    return;
  }
  switch (node.gateType) {
    case 'INPUT':
      renderInputNodeBody(node, bodies, theme);
      break;
    case 'OUTPUT':
      renderOutputNodeBody(node, bodies, theme);
      break;
    case 'AND':
      renderGateNodeBody(node, 'and', '&', bodies, theme);
      break;
    case 'OR':
      renderGateNodeBody(node, 'or', '\u22651', bodies, theme);
      break;
    case 'NOT':
      renderNotNodeBody(node, bodies, theme);
      break;
    default:
      renderGateNodeBody(node, 'and', '&', bodies, theme);
  }
}

function renderNodePorts(node: LayoutNode, ports: string[], opts: RenderOptions, theme: DiagramTheme): void {
  if (node.gateType === 'INPUT') {
    const port = node.outputs[0];
    if (port) {
      const x = port.absX;
      const y = port.absY;
      if (opts.portStyle === 'SQUARE') {
        const size = PORT_SIZE;
        ports.push(`<rect class="ldl-port ldl-output ldl-port-square" data-port="out" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" fill="${theme.portFill}"/>`);
      } else {
        ports.push(`<circle class="ldl-port ldl-output ldl-port-circle" data-port="out" cx="${x}" cy="${y}" r="${3}" fill="${theme.portFill}"/>`);
      }
    }
  } else if (node.gateType === 'OUTPUT') {
    const port = node.inputs[0];
    if (port) {
      if (port.bubbled) {
        // NOT feeding straight into an output: bubble sits just left of the output port.
        const bubbleCenterX = port.absX + BUBBLE_R;
        ports.push(`<circle class="ldl-bubble ldl-input" data-port="in" cx="${bubbleCenterX}" cy="${port.absY}" r="${BUBBLE_R}" fill="${theme.fill}" stroke="${theme.stroke}" stroke-width="1.5"/>`);
      } else {
        ports.push(portMarker(port.absX, port.absY, 'ldl-input', 'in', opts, theme));
      }
    }
  } else {
    // Inversion bubbles are drawn ONLY on ports actually marked inverted; every other
    // port gets a normal marker. A bubbled input port was shifted left by BUBBLE_R*2 in
    // layout, so the bubble (centre = port.absX + BUBBLE_R) sits just outside the gate
    // edge with its inner edge meeting the gate (straight edge for AND/NOT, curve for OR).
    for (const port of node.inputs) {
      if (port.bubbled) {
        const bubbleCenterX = port.absX + BUBBLE_R;
        ports.push(`<circle class="ldl-bubble ldl-input" data-port="${esc(port.name)}" cx="${bubbleCenterX}" cy="${port.absY}" r="${BUBBLE_R}" fill="${theme.fill}" stroke="${theme.stroke}" stroke-width="1.5"/>`);
      } else {
        ports.push(portMarker(port.absX, port.absY, 'ldl-input', port.name, opts, theme));
      }
    }
    for (const port of node.outputs) {
      if (port.bubbledOutput) {
        const bubbleCenterX = port.absX - BUBBLE_R;
        ports.push(`<circle class="ldl-bubble ldl-output" data-port="${esc(port.name)}" cx="${bubbleCenterX}" cy="${port.absY}" r="${BUBBLE_R}" fill="${theme.fill}" stroke="${theme.stroke}" stroke-width="1.5"/>`);
      } else {
        ports.push(portMarker(port.absX, port.absY, 'ldl-output', port.name, opts, theme));
      }
    }
  }
}

function portMarker(x: number, y: number, dir: 'ldl-input' | 'ldl-output', name: string, opts: RenderOptions, theme: DiagramTheme): string {
  if (opts.portStyle === 'SQUARE') {
    const size = PORT_SIZE;
    return `<rect class="ldl-port ${dir} ldl-port-square" data-port="${esc(name)}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" fill="${theme.portFill}"/>`;
  }
  return `<circle class="ldl-port ${dir} ldl-port-circle" data-port="${esc(name)}" cx="${x}" cy="${y}" r="${3}" fill="${theme.portFill}"/>`;
}

function renderNodeLabels(node: LayoutNode, showLabels: boolean, labels: string[], theme: DiagramTheme): void {
  if (!showLabels) return;

  if (node.gateType === 'INPUT') {
    const port = node.outputs[0];
    if (port) {
      const labelLeft = port.absX - 10;
      const nameHasMath = node.name ? hasMathContent(node.name) : false;
      const descHasMath = node.description ? hasMathContent(node.description) : false;
      if (nameHasMath || descHasMath) {
        labels.push(renderInputMathLabel(labelLeft, port.absY, node.label ?? '', theme, node.name, node.description));
      } else {
        labels.push(renderInputPortLabel(labelLeft, port.absY, node.label ?? '', theme, node.name, node.description));
      }
    }
  } else if (node.gateType === 'OUTPUT') {
    const port = node.inputs[0];
    if (port) {
      const labelLeft = port.absX + 10;
      const nameHasMath = node.name ? hasMathContent(node.name) : false;
      const descHasMath = node.description ? hasMathContent(node.description) : false;
      if (nameHasMath || descHasMath) {
        labels.push(renderOutputMathLabel(labelLeft, port.absY, node.label ?? '', theme, node.name, node.description));
      } else {
        labels.push(renderOutputPortLabel(labelLeft, port.absY, node.label ?? '', theme, node.name, node.description));
      }
    }
  }
}

function renderNodeIds(node: LayoutNode, showIds: boolean, ids: string[], theme: DiagramTheme): void {
  if (!showIds) return;
  if (node.gateType === 'INPUT') {
    const port = node.outputs[0];
    if (port) {
      ids.push(`<text class="ldl-id" x="${port.absX + PORT_SIZE / 2 + 3}" y="${port.absY + 3}" text-anchor="start" fill="${theme.idFill}" font-size="10" font-family="sans-serif" font-weight="600">${esc(node.label ?? '')}</text>`);
    }
  } else if (node.gateType === 'OUTPUT') {
    const port = node.inputs[0];
    if (port) {
      ids.push(`<text class="ldl-id" x="${port.absX - PORT_SIZE / 2 - 3}" y="${port.absY + 3}" text-anchor="end" fill="${theme.idFill}" font-size="10" font-family="sans-serif" font-weight="600">${esc(node.label ?? '')}</text>`);
    }
  } else {
    for (const p of node.inputs) {
      ids.push(`<text class="ldl-id" x="${p.absX - PORT_SIZE / 2 - 3}" y="${p.absY + 3}" text-anchor="end" fill="${theme.idFill}" font-size="10" font-family="sans-serif" font-weight="600">${esc(p.name)}</text>`);
    }
    if (node.outputs.length > 0) {
      const p = node.outputs[0];
      ids.push(`<text class="ldl-id" x="${p.absX + PORT_SIZE / 2 + 3}" y="${p.absY + 3}" text-anchor="start" fill="${theme.idFill}" font-size="10" font-family="sans-serif" font-weight="600">out</text>`);
    }
  }
}

function renderInputNodeBody(node: LayoutNode, bodies: string[], theme: DiagramTheme): void {
  const port = node.outputs[0];
  if (!port) return;

  const labelRight = node.absX + node.width - 10;
  bodies.push(`<line class="ldl-wire" x1="${labelRight}" y1="${port.absY}" x2="${port.absX}" y2="${port.absY}"/>`);
}

function renderOutputNodeBody(node: LayoutNode, bodies: string[], theme: DiagramTheme): void {
  const port = node.inputs[0];
  if (!port) return;

  const labelLeft = port.absX + 10;
  bodies.push(`<line class="ldl-wire" x1="${port.absX}" y1="${port.absY}" x2="${labelLeft}" y2="${port.absY}"/>`);
}

function renderGateNodeBody(node: LayoutNode, shape: 'and' | 'or', symbol: string, bodies: string[], theme: DiagramTheme): void {
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
  parts.push(`  <path d="${bodyPath}" transform="translate(${x}, ${y})" fill="${theme.fill}" stroke="${theme.stroke}" stroke-width="2.5"/>`);

  parts.push(`  <text x="${x + w / 2}" y="${y + h / 2 + fontSize * 0.35}" text-anchor="middle" fill="${theme.stroke}" font-size="${fontSize}" font-weight="700" font-family="sans-serif">${esc(symbol)}</text>`);

  if (node.barsMode && node.inputs.length > 2) {
    const barX = x - INPUT_BAR_OFFSET;
    parts.push(`  <line class="ldl-input-bar" x1="${barX}" y1="${y}" x2="${barX}" y2="${y + h}" stroke="${theme.stroke}" stroke-width="2.5"/>`);
    for (let i = 2; i < node.inputs.length; i++) {
      const port = node.inputs[i];
      const stubEnd = x - INPUT_BAR_STUB;
      parts.push(`  <line class="ldl-bar-stub" x1="${barX}" y1="${port.absY}" x2="${stubEnd}" y2="${port.absY}" stroke="${theme.wire}" stroke-width="2.5"/>`);
    }
  }

  parts.push('</g>');

  bodies.push(parts.join('\n'));
}

function renderNotNodeBody(node: LayoutNode, bodies: string[], theme: DiagramTheme): void {
  const x = node.absX;
  const y = node.absY;
  const h = NOT_GATE_H;

  const bodyPath = notGateBody(NOT_TRIANGLE_W, h);

  const parts: string[] = [];
  parts.push(`<g class="ldl-symbol ldl-gate-not" id="${esc(node.id)}">`);
  parts.push(`  <path d="${bodyPath}" transform="translate(${x}, ${y})" fill="${theme.fill}" stroke="${theme.stroke}" stroke-width="2.5"/>`);
  parts.push(`  <circle cx="${x + NOT_TRIANGLE_W + BUBBLE_R}" cy="${y + h / 2}" r="${BUBBLE_R}" fill="${theme.fill}" stroke="${theme.stroke}" stroke-width="2.5"/>`);
  parts.push(`  <text x="${x + NOT_TRIANGLE_W * 0.38}" y="${y + h / 2 + 4}" text-anchor="middle" fill="${theme.stroke}" font-size="11" font-weight="700" font-family="sans-serif">NOT</text>`);

  if (node.outputs.length > 0) {
    const outPort = node.outputs[0];
    const stubStartX = x + NOT_TRIANGLE_W + BUBBLE_R * 2;
    parts.push(`  <line class="ldl-wire" x1="${stubStartX}" y1="${y + h / 2}" x2="${outPort.absX}" y2="${y + h / 2}"/>`);
  }

  parts.push('</g>');

  bodies.push(parts.join('\n'));
}

function renderMixedLabelContent(
  segments: { type: 'plain' | 'math'; text: string }[],
  baseX: number,
  baseY: number,
  anchor: 'start' | 'end',
  fontSize: number,
  fill: string,
  isDescription: boolean,
): string {
  const parts: string[] = [];
  const classSuffix = isDescription ? 'ldl-description' : 'ldl-name';
  const fontWeight = isDescription ? '' : ' font-weight="500"';
  // Small gap so a plain segment and an adjacent math segment never visually touch.
  const segGap = segments.length > 1 ? fontSize * 0.18 : 0;

  // width = glyph/text advance (used for placement); segGap is added only between segments.
  const measured: { type: 'plain' | 'math'; text: string; width: number; svg?: string; baselineOffset: number }[] = [];

  for (const seg of segments) {
    if (seg.type === 'plain') {
      measured.push({ type: 'plain', text: seg.text, width: estimateTextWidth(seg.text, fontSize), baselineOffset: 0 });
    } else {
      const result = renderMath(seg.text, fontSize);
      measured.push({
        type: 'math',
        text: seg.text,
        width: result?.width ?? estimateTextWidth(seg.text, fontSize),
        svg: result?.svg,
        baselineOffset: result?.baselineOffset ?? 0,
      });
    }
  }

  if (anchor === 'end') {
    const rightEdges: number[] = [];
    let currentRight = baseX;
    for (let i = measured.length - 1; i >= 0; i--) {
      rightEdges[i] = currentRight;
      currentRight -= measured[i].width + segGap;
    }

    for (let i = 0; i < measured.length; i++) {
      const seg = measured[i];
      const rightEdge = rightEdges[i];
      if (seg.type === 'plain') {
        parts.push(`<text class="ldl-label ${classSuffix}" x="${rightEdge}" y="${baseY}" text-anchor="end" fill="${fill}" font-size="${fontSize}" font-family="sans-serif"${fontWeight}>${esc(seg.text)}</text>`);
      } else if (seg.svg) {
        parts.push(`<g class="ldl-math" transform="translate(${rightEdge - seg.width}, ${baseY - seg.baselineOffset})">${seg.svg}</g>`);
      }
    }
  } else {
    let leftX = baseX;
    for (const seg of measured) {
      if (seg.type === 'plain') {
        parts.push(`<text class="ldl-label ${classSuffix}" x="${leftX}" y="${baseY}" text-anchor="start" fill="${fill}" font-size="${fontSize}" font-family="sans-serif"${fontWeight}>${esc(seg.text)}</text>`);
      } else if (seg.svg) {
        parts.push(`<g class="ldl-math" transform="translate(${leftX}, ${baseY - seg.baselineOffset})">${seg.svg}</g>`);
      }
      leftX += seg.width + segGap;
    }
  }

  return parts.join('\n');
}

function renderInputMathLabel(absX: number, absY: number, label: string, theme: DiagramTheme, name?: string, description?: string): string {
  const displayName = name || label;
  const labelGap = 6;
  const textX = absX - labelGap;
  const nameY = description ? absY - 6 : absY + 4;
  const descY = description ? absY + 12 : 0;

  const parts: string[] = [];

  const nameSegments = splitIntoSegments(displayName);
  parts.push(renderMixedLabelContent(nameSegments, textX, nameY, 'end', 12, theme.nameFill, false));

  if (description) {
    const descSegments = splitIntoSegments(description);
    parts.push(renderMixedLabelContent(descSegments, textX, descY, 'end', 9, theme.descFill, true));
  }

  parts.push(`<text class="ldl-id" x="${textX}" y="${absY - PORT_SIZE / 2 - 4}" text-anchor="end" fill="${theme.idFill}" font-size="10" font-family="sans-serif" font-weight="600">${esc(label)}</text>`);

  return parts.join('\n');
}

function renderOutputMathLabel(absX: number, absY: number, label: string, theme: DiagramTheme, name?: string, description?: string): string {
  const displayName = name || label;
  const labelGap = 6;
  const textX = absX + labelGap;
  const nameY = description ? absY - 6 : absY + 4;
  const descY = description ? absY + 12 : 0;

  const parts: string[] = [];

  const nameSegments = splitIntoSegments(displayName);
  parts.push(renderMixedLabelContent(nameSegments, textX, nameY, 'start', 12, theme.nameOutFill, false));

  if (description) {
    const descSegments = splitIntoSegments(description);
    parts.push(renderMixedLabelContent(descSegments, textX, descY, 'start', 9, theme.descFill, true));
  }

  parts.push(`<text class="ldl-id" x="${textX}" y="${absY - PORT_SIZE / 2 - 4}" text-anchor="start" fill="${theme.idFill}" font-size="10" font-family="sans-serif" font-weight="600">${esc(label)}</text>`);

  return parts.join('\n');
}
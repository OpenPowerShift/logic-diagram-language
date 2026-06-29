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

const INPUT_BAR_OFFSET = 12;
const INPUT_BAR_STUB = 6;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderDiagram(diagram: Diagram, portMeta?: PortMeta[], showLabels: boolean = true, showIds: boolean = false, options?: RenderOptions, diagramTheme?: DiagramTheme): string {
  const opts = options ?? DEFAULT_OPTIONS;
  const theme = diagramTheme ?? LIGHT_DIAGRAM;
  const layout = layoutDiagram(diagram, portMeta, opts);

  // Style payload: user STYLE blocks (parser already stored them as StyleDecl[]). Concatenated
  // as-is into the rendered SVG's <defs><style>, so #ID selectors from `STYLE ... END STYLE` work
  // restyling of the semantic SVG IDs in Item 10.
  const userCss = diagram.styles.map(s => s.css).join('\n');

  const svgWires: string[] = [];
  const svgBodies: string[] = [];
  const svgPorts: string[] = [];
  const svgJunctions: string[] = [];
  const svgIds: string[] = [];
  const svgLabels: string[] = [];

  for (let wi = 0; wi < layout.wires.length; wi++) {
    const wire = layout.wires[wi];
    svgWires.push(renderWire(wire.points, wire.fromId, wire.toId, `wire_${wi}`, wire.feedback));
  }

  for (const node of layout.nodes) {
    renderNodeBody(node, svgBodies, layout.options, theme);
    renderNodePorts(node, svgPorts, layout.options, theme);
    renderNodeLabels(node, showLabels, svgLabels, theme);
    renderNodeIds(node, showIds, svgIds, theme);
  }

  for (let ji = 0; ji < layout.junctions.length; ji++) {
    const j = layout.junctions[ji];
    svgJunctions.push(`<g class="ldl-junction-group" id="dot_${ji}" data-ldl-x="${j.x}" data-ldl-y="${j.y}">${renderJunctionDot(j.x, j.y, theme)}</g>`);
  }

  if (showLabels) for (let li = 0; li < layout.labels.length; li++) {
    const lbl = layout.labels[li];
    // Net label for a consumed intermediate, drawn above its fan-out junction.
    const cx = lbl.x + lbl.width / 2;
    let ty = lbl.y + 11;
    svgLabels.push(`<g class="ldl-net-label" id="netlabel_${li}">`);
    if (lbl.name) {
      svgLabels.push(`<text class="ldl-label ldl-name" x="${cx}" y="${ty}" text-anchor="middle" fill="${theme.nameFill}" font-size="11" font-family="sans-serif" font-weight="600">${esc(lbl.name)}</text>`);
      ty += 12;
    }
    if (lbl.description) {
      svgLabels.push(`<text class="ldl-label ldl-description" x="${cx}" y="${ty}" text-anchor="middle" fill="${theme.descFill}" font-size="9" font-family="sans-serif">${esc(lbl.description)}</text>`);
    }
    svgLabels.push('</g>');
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
  if (showLabels) for (const lbl of layout.labels) {
    minX = Math.min(minX, lbl.x); maxX = Math.max(maxX, lbl.x + lbl.width);
    minY = Math.min(minY, lbl.y); maxY = Math.max(maxY, lbl.y + lbl.height);
  }

  const pad = 30;
  const svgW = (maxX - minX) + pad * 2;
  const svgH = (maxY - minY) + pad * 2;
  const tx = pad - minX;
  const ty = pad - minY;

  const labelsClass = showLabels ? 'ldl-show-labels' : '';
  const idsClass = showIds ? 'ldl-show-ids' : '';
  const hideDotsClass = opts.hideJunctions ? 'ldl-hide-dots' : '';
  // Layer visibility via root class — Item 10/11 enables a stylesheet (or the user's STYLE block)
  // to toggle whole layers by writing `svg.ldl-hide-dots .ldl-junction { display: none; }`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" class="ldl-diagram ${labelsClass} ${idsClass} ${hideDotsClass}" style="max-width:100%;max-height:100%;">
  <defs>
    <style>
      .ldl-wire { stroke: ${theme.wire}; fill: none; stroke-width: ${opts.strokeWidth ?? 2.5}; stroke-linecap: round; stroke-linejoin: round; transition: stroke 0.2s; }
      .ldl-wire:hover { stroke: ${theme.wireHover}; stroke-width: ${(opts.strokeWidth ?? 2.5) + 1}; }
      .ldl-symbol { transition: filter 0.15s; }
      .ldl-symbol:hover { filter: brightness(1.3); }
      /* Custom stroke-width (Item 10): user-set OPTION STROKE_WIDTH overrides the body defaults
         via CSS, so a single knob restyles every gate/block body + bubbles + input bars uniformly. */
      .ldl-symbol path, .ldl-symbol rect, .ldl-symbol circle, .ldl-input-bar, .ldl-bar-stub { stroke-width: ${opts.strokeWidth ?? 2.5}; }
      .ldl-input-port text { fill: ${theme.nameFill}; }
      .ldl-output-port text { fill: ${theme.nameOutFill}; }
      .ldl-port { transition: filter 0.15s; }
      .ldl-port:hover { filter: brightness(1.5); }
      .ldl-diagram:not(.ldl-show-labels) .ldl-label { display: none; }
      .ldl-diagram:not(.ldl-show-ids) .ldl-id { display: none; }
      .ldl-diagram.ldl-show-labels .ldl-label { display: block; }
      .ldl-diagram.ldl-show-ids .ldl-id { display: block; }
      .ldl-diagram.ldl-hide-dots .ldl-junction-group { display: none; }
      /* User-supplied STYLE blocks (Item 10): #ID selectors restyle the semantic SVG ids
         emitted on gates/blocks/inputs/outputs/junctions/ports/wires. */
${userCss ? '      ' + userCss.split('\n').join('\n      ') + '\n' : ''}
    </style>
  </defs>
  <rect x="0" y="0" width="${svgW}" height="${svgH}" fill="${theme.background}" rx="4"/>
  <g class="ldl-layer-root" transform="translate(${tx}, ${ty})">
    <g class="ldl-layer-wires">${svgWires.join('')}</g>
    <g class="ldl-layer-bodies">${svgBodies.join('')}</g>
    <g class="ldl-layer-ports">${svgPorts.join('')}</g>
    <g class="ldl-layer-dots">${svgJunctions.join('')}</g>
    <g class="ldl-layer-objects">${svgIds.join('')}</g>
    <g class="ldl-layer-labels">${svgLabels.join('')}</g>
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
    case 'TIMER':
    case 'SR':
    case 'RISING':
    case 'FALLING':
    case 'COMPARE':
      renderBlockNodeBody(node, bodies, theme);
      break;
    case 'FB':
      renderFbNodeBody(node, bodies, theme);
      break;
    default:
      renderGateNodeBody(node, 'and', '&', bodies, theme);
  }
}

// Small rising/falling edge step glyphs (a low-high or high-low step), used on TIMER (PU/DO)
// and the RISING/FALLING blocks.
function edgeGlyph(x: number, y: number, rising: boolean, stroke: string): string {
  const d = rising ? `M ${x} ${y + 8} L ${x + 6} ${y + 8} L ${x + 6} ${y} L ${x + 14} ${y}`
                   : `M ${x} ${y} L ${x + 6} ${y} L ${x + 6} ${y + 8} L ${x + 14} ${y + 8}`;
  return `  <path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`;
}

function fmtDuration(v?: string): string {
  if (v === undefined || v === '') return '0';
  return /[a-z]/i.test(v) ? v : `${v}cyc`;
}

// Generic user block: a square box with the name centred inside, labelled input ports on the
// left and labelled output ports on the right. The description is rendered below (renderNodeLabels).
function renderFbNodeBody(node: LayoutNode, bodies: string[], theme: DiagramTheme): void {
  const x = node.absX, y = node.absY, w = node.width, h = node.height;
  const stroke = theme.stroke, fill = theme.fill;
  const parts: string[] = [`<g class="ldl-symbol ldl-block ldl-block-fb" id="${esc(svgObjectId(node))}" data-ldl-id="${esc(node.id)}">`];
  parts.push(`  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>`);
  if (node.name) {
    parts.push(`  <text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" fill="${stroke}" font-size="11" font-weight="700" font-family="sans-serif">${esc(node.name)}</text>`);
  }
  for (const p of node.inputs) {
    if (p.label) parts.push(`  <text x="${x + 6}" y="${p.absY + 3.5}" text-anchor="start" fill="${stroke}" font-size="9" font-family="sans-serif">${esc(p.label)}</text>`);
  }
  for (const p of node.outputs) {
    if (p.label) parts.push(`  <text x="${x + w - 6}" y="${p.absY + 3.5}" text-anchor="end" fill="${stroke}" font-size="9" font-family="sans-serif">${esc(p.label)}</text>`);
  }
  parts.push('</g>');
  bodies.push(parts.join('\n'));
}

// SEL-style function blocks: rectangle for TIMER/SR/RISING/FALLING, comparator triangle for
// COMPARE. Labels mirror SEL documentation (PU/DO, S/R/Q, +/−).
function renderBlockNodeBody(node: LayoutNode, bodies: string[], theme: DiagramTheme): void {
  const x = node.absX, y = node.absY, w = node.width, h = node.height;
  const stroke = theme.stroke, fill = theme.fill;
  const txt = (tx: number, ty: number, s: string, size = 11, anchor = 'middle') =>
    `  <text x="${tx}" y="${ty}" text-anchor="${anchor}" fill="${stroke}" font-size="${size}" font-weight="700" font-family="sans-serif">${esc(s)}</text>`;
  const parts: string[] = [`<g class="ldl-symbol ldl-block ldl-block-${(node.blockType ?? '').toLowerCase()}" id="${esc(svgObjectId(node))}" data-ldl-id="${esc(node.id)}">`];

  // Port labels track the actual port Y (ports can be shifted/expanded to straighten wires).
  if (node.blockType === 'COMPARE') {
    parts.push(`  <path d="M ${x} ${y} L ${x} ${y + h} L ${x + w} ${y + h / 2} Z" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>`);
    if (node.inputs[0]) parts.push(txt(x + 13, node.inputs[0].absY + 5, '+', 14));
    if (node.inputs[1]) parts.push(txt(x + 13, node.inputs[1].absY + 5, '−', 14));
  } else {
    parts.push(`  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>`);
    if (node.blockType === 'SR') {
      if (node.inputs[0]) parts.push(txt(x + 12, node.inputs[0].absY + 4, 'S'));
      if (node.inputs[1]) parts.push(txt(x + 12, node.inputs[1].absY + 4, 'R'));
      for (const o of node.outputs) {
        const ly = o.absY;
        parts.push(txt(x + w - 12, ly + 4, 'Q'));
        if (o.name === 'NQ') parts.push(`  <line x1="${x + w - 17}" y1="${ly - 7}" x2="${x + w - 7}" y2="${ly - 7}" stroke="${stroke}" stroke-width="1.5"/>`);
      }
    } else if (node.blockType === 'TIMER') {
      // Diagonal ramp from bottom-left to top-right; pickup (PU) in the upper-left, dropout (DO)
      // in the lower-right — the SEL timer convention.
      parts.push(`  <line x1="${x}" y1="${y + h}" x2="${x + w}" y2="${y}" stroke="${stroke}" stroke-width="1.5"/>`);
      parts.push(txt(x + w * 0.30, y + h * 0.36, fmtDuration(node.params?.PU), 10));
      parts.push(txt(x + w * 0.70, y + h * 0.78, fmtDuration(node.params?.DO), 10));
    } else if (node.blockType === 'RISING' || node.blockType === 'FALLING') {
      parts.push(edgeGlyph(x + w / 2 - 7, y + h / 2 - 4, node.blockType === 'RISING', stroke));
    }
  }
  parts.push('</g>');
  bodies.push(parts.join('\n'));
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
  } else if (node.blockType && (node.name || node.description)) {
    // SEL function blocks show their instance name above and description below the body. A generic
    // FB block shows its name inside the box (renderFbNodeBody), so only the description goes below.
    const cx = node.absX + node.width / 2;
    if (node.name && node.blockType !== 'FB') {
      labels.push(`<text class="ldl-label ldl-name" x="${cx}" y="${node.absY - 7}" text-anchor="middle" fill="${theme.nameFill}" font-size="12" font-family="sans-serif" font-weight="600">${esc(node.name)}</text>`);
    }
    if (node.description) {
      labels.push(`<text class="ldl-label ldl-description" x="${cx}" y="${node.absY + node.height + 15}" text-anchor="middle" fill="${theme.descFill}" font-size="9" font-family="sans-serif">${esc(node.description)}</text>`);
    }
  } else if (!node.blockType && node.gateType !== 'INPUT' && node.gateType !== 'OUTPUT' && (node.name || node.description)) {
    // A named gate (AND#ID(...)) shows its instance name above and description below the body,
    // mirroring the SEL block label placement.
    const cx = node.absX + node.width / 2;
    if (node.name && node.blockType !== 'FB') {
      labels.push(`<text class="ldl-label ldl-name" x="${cx}" y="${node.absY - 7}" text-anchor="middle" fill="${theme.nameFill}" font-size="12" font-family="sans-serif" font-weight="600">${esc(node.name)}</text>`);
    }
    if (node.description) {
      labels.push(`<text class="ldl-label ldl-description" x="${cx}" y="${node.absY + node.height + 15}" text-anchor="middle" fill="${theme.descFill}" font-size="9" font-family="sans-serif">${esc(node.description)}</text>`);
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

function svgObjectId(node: LayoutNode): string {
  // Inputs/outputs are addressed by their name (e.g. I1, O2 — unique per diagram); gates/blocks
  // by their instance label when set (an explicit `#ID`), else by internal id (e.g. and_4).
  // CSS `#ID` selectors in the user's STYLE block thus target the user-facing identifier.
  if (node.gateType === 'INPUT' || node.gateType === 'OUTPUT') return node.label ?? node.id;
  return node.label ?? node.id;
}

function renderInputNodeBody(node: LayoutNode, bodies: string[], theme: DiagramTheme): void {
  const port = node.outputs[0];
  if (!port) return;
  const sid = svgObjectId(node);
  const labelRight = node.absX + node.width - 10;
  bodies.push(`<g class="ldl-symbol ldl-io ldl-input" id="${esc(sid)}" data-ldl-id="${esc(node.id)}"><line class="ldl-id-stub ldl-wire" x1="${labelRight}" y1="${port.absY}" x2="${port.absX}" y2="${port.absY}"/></g>`);
}

function renderOutputNodeBody(node: LayoutNode, bodies: string[], theme: DiagramTheme): void {
  const port = node.inputs[0];
  if (!port) return;
  const sid = svgObjectId(node);
  const labelLeft = port.absX + 10;
  bodies.push(`<g class="ldl-symbol ldl-io ldl-output" id="${esc(sid)}" data-ldl-id="${esc(node.id)}"><line class="ldl-id-stub ldl-wire" x1="${port.absX}" y1="${port.absY}" x2="${labelLeft}" y2="${port.absY}"/></g>`);
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
  parts.push(`<g class="ldl-symbol ${cls}" id="${esc(svgObjectId(node))}" data-ldl-id="${esc(node.id)}">`);
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
  parts.push(`<g class="ldl-symbol ldl-gate-not" id="${esc(svgObjectId(node))}" data-ldl-id="${esc(node.id)}">`);
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
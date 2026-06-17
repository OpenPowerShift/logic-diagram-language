import type { DiagramTheme } from '../theme/themes.js';

export const PORT_SIZE = 5;
export const PORT_R = 3;

export const GATE_W = 60;
export const GATE_W_MULTI = 75;
export const NOT_TRIANGLE_W = 50;
export const BUBBLE_R = 5;
export const NOT_GATE_TOTAL_W = NOT_TRIANGLE_W + BUBBLE_R * 2 + 5;
export const NOT_GATE_H = 40;
export const AND_GATE_H_BASE = 45;
export const PORT_SPACING = 15;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function andGateBody(w: number, h: number): string {
  const r = h / 2;
  return `M 0,0 L ${w - r},0 A ${r},${r} 0 0,1 ${w - r},${h} L 0,${h} Z`;
}

export function orGateBody(w: number, h: number): string {
  return [
    `M 0,0`,
    `C ${w * 0.5},0 ${w * 0.8},${h * 0.15} ${w},${h / 2}`,
    `C ${w * 0.8},${h * 0.85} ${w * 0.5},${h} 0,${h}`,
    `C ${w * 0.18},${h * 0.65} ${w * 0.18},${h * 0.35} 0,0`,
    `Z`,
  ].join(' ');
}

export function notGateBody(w: number, h: number): string {
  return `M 0,0 L ${w},${h / 2} L 0,${h} Z`;
}

export function renderJunctionDot(x: number, y: number, theme: DiagramTheme): string {
  return `<circle class="ldl-junction" cx="${x}" cy="${y}" r="4" fill="${theme.junctionFill}" stroke="${theme.junctionFill}" stroke-width="1"/>`;
}

export function renderInputPortLabel(absX: number, absY: number, label: string, theme: DiagramTheme, name?: string, description?: string): string {
  const displayName = name || label;
  const labelGap = 6;
  const textX = absX - labelGap;
  const nameY = description ? absY - 6 : absY + 4;
  const descY = description ? absY + 12 : 0;

  const parts: string[] = [];
  parts.push(`<text class="ldl-label ldl-name" x="${textX}" y="${nameY}" text-anchor="end" fill="${theme.nameFill}" font-size="12" font-family="sans-serif" font-weight="500">${esc(displayName)}</text>`);
  if (description) {
    parts.push(`<text class="ldl-label ldl-description" x="${textX}" y="${descY}" text-anchor="end" fill="${theme.descFill}" font-size="9" font-family="sans-serif">${esc(description)}</text>`);
  }
  parts.push(`<text class="ldl-id" x="${absX - labelGap}" y="${absY - PORT_SIZE / 2 - 4}" text-anchor="end" fill="${theme.idFill}" font-size="10" font-family="sans-serif" font-weight="600">${esc(label)}</text>`);

  return parts.join('\n');
}

export function renderOutputPortLabel(absX: number, absY: number, label: string, theme: DiagramTheme, name?: string, description?: string): string {
  const displayName = name || label;
  const labelGap = 6;
  const textX = absX + labelGap;
  const nameY = description ? absY - 6 : absY + 4;
  const descY = description ? absY + 12 : 0;

  const parts: string[] = [];
  parts.push(`<text class="ldl-label ldl-name" x="${textX}" y="${nameY}" text-anchor="start" fill="${theme.nameOutFill}" font-size="12" font-family="sans-serif" font-weight="600">${esc(displayName)}</text>`);
  if (description) {
    parts.push(`<text class="ldl-label ldl-description" x="${textX}" y="${descY}" text-anchor="start" fill="${theme.descFill}" font-size="9" font-family="sans-serif">${esc(description)}</text>`);
  }
  parts.push(`<text class="ldl-id" x="${absX + labelGap}" y="${absY - PORT_SIZE / 2 - 4}" text-anchor="start" fill="${theme.idFill}" font-size="10" font-family="sans-serif" font-weight="600">${esc(label)}</text>`);

  return parts.join('\n');
}
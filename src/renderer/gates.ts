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

// Maximum rightward bulge of the OR gate's concave left edge, at mid-height.
// Fixed (independent of gate height) so concavity reads consistently across sizes.
export const OR_CURVE_DEPTH = 10;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function andGateBody(w: number, h: number): string {
  // Rounded right side. Cap the corner radius at w/2 so tall gates don't produce a
  // negative top edge (r=h/2 would make w-r < 0 once h > w) — the body then becomes a
  // stadium/rounded rectangle. For short gates (h <= w) this is exactly the classic
  // semicircular "D" shape, since the straight right edge between the corners is zero.
  const r = Math.min(h / 2, w / 2);
  return [
    `M 0,0`,
    `L ${w - r},0`,
    `A ${r},${r} 0 0 1 ${w},${r}`,
    `L ${w},${h - r}`,
    `A ${r},${r} 0 0 1 ${w - r},${h}`,
    `L 0,${h}`,
    `Z`,
  ].join(' ');
}

export function orGateBody(w: number, h: number): string {
  // Left edge is a single quadratic Bézier whose control point (2*depth, h/2)
  // makes the curve's X an exact function of Y: x(localY) = orCurveTapX(h, localY).
  // This lets input ports tap the curve precisely and keeps a constant concavity.
  const cx = OR_CURVE_DEPTH * 2;
  return [
    `M 0,0`,
    `C ${w * 0.5},0 ${w * 0.8},${h * 0.15} ${w},${h / 2}`,
    `C ${w * 0.8},${h * 0.85} ${w * 0.5},${h} 0,${h}`,
    `Q ${cx},${h / 2} 0,0`,
    `Z`,
  ].join(' ');
}

// Exact X (rightward offset from the bbox left edge) of the OR gate's concave left
// curve at a given local Y. Derived from the quadratic Bézier in orGateBody:
//   x(localY) = 4 * depth * (localY/h) * (1 - localY/h)
// Peaks at OR_CURVE_DEPTH when localY == h/2, and is 0 at the top/bottom corners.
export function orCurveTapX(h: number, localY: number): number {
  if (h <= 0) return 0;
  const f = localY / h;
  return 4 * OR_CURVE_DEPTH * f * (1 - f);
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
  // The id text is emitted separately by renderNodeIds (svg-renderer), gated on showIds, so it is
  // omitted from the SVG entirely when IDs are off — a CSS-hidden id leaks into non-browser SVG
  // viewers, which was the bug. `label` is retained above as the displayName fallback.

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
  // The id text is emitted separately by renderNodeIds (svg-renderer), gated on showIds — see note
  // in renderInputPortLabel.

  return parts.join('\n');
}
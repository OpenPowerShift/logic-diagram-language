export interface WirePoint {
  x: number;
  y: number;
}

// Render a single wire as a <path> with stable id, `data-from`/`data-to` net links, and a
// `ldl-feedback` class for loop-back wires so CSS styling can distinguish them.
export function renderWire(
  points: WirePoint[],
  fromId: string,
  toId: string,
  svgId?: string,
  feedback?: boolean,
): string {
  if (points.length < 2) return '';

  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`)
    .join(' ');

  const id = svgId ?? `wire_${fromId}_to_${toId}`;
  const fbClass = feedback ? ' ldl-feedback' : '';

  return `<path class="ldl-wire${fbClass}" id="${id}" data-from="${fromId}" data-to="${toId}" d="${d}"/>`;
}
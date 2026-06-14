export interface WirePoint {
  x: number;
  y: number;
}

export function renderWire(
  points: WirePoint[],
  fromId: string,
  toId: string,
): string {
  if (points.length < 2) return '';

  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`)
    .join(' ');

  const id = `wire_${fromId}_to_${toId}`;

  return `<path class="ldl-wire" id="${id}" d="${d}"/>`;
}
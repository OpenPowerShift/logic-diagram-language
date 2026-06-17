import { describe, it } from 'vitest';
import { parse } from '../../src/parser/parser';
import { layoutDiagram } from '../../src/renderer/layout';
import { EXAMPLES } from '../../src/examples';

function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
  pad = 0,
) {
  return ax < bx + bw + pad && ax + aw > bx - pad && ay < by + bh + pad && ay + ah > by - pad;
}

describe('debug MCC', () => {
  it('dumps', () => {
    const src = EXAMPLES['Motor Control Circuit'];
    const r = parse(src);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta);

    const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');

    for (const w of l.wires) {
      const pts = w.points.map(p => '(' + p.x + ',' + p.y + ')').join(' -> ');
      console.log('Wire', w.fromId, '->', w.toId, ': ', pts);
      for (let i = 0; i < w.points.length - 1; i++) {
        const p0 = w.points[i], p1 = w.points[i + 1];
        const isHoriz = Math.abs(p0.y - p1.y) < 1;
        const isVert = Math.abs(p0.x - p1.x) < 1;
        if (!isHoriz && !isVert) {
          console.log('  NON-ORTHOGONAL SEGMENT!');
          continue;
        }
        for (const g of gates) {
          if (g.id === w.fromId || g.id === w.toId) continue;
          let overlaps = false;
          if (isHoriz) {
            const xMin = Math.min(p0.x, p1.x);
            const xMax = Math.max(p0.x, p1.x);
            if (xMax - xMin < 1) continue;
            overlaps = rectsOverlap(xMin, p0.y - 4, xMax - xMin, 8, g.absX, g.absY, g.width, g.height, 2);
            if (overlaps) {
              console.log('  OVERLAP with', g.id, 'type=' + g.gateType, 'at', g.absX, g.absY, g.width, g.height);
              console.log('    seg:', p0.x, p0.y, '->', p1.x, p1.y);
            }
          } else {
            const yMin = Math.min(p0.y, p1.y);
            const yMax = Math.max(p0.y, p1.y);
            if (yMax - yMin < 1) continue;
            overlaps = rectsOverlap(p0.x - 4, yMin, 8, yMax - yMin, g.absX, g.absY, g.width, g.height, 2);
            if (overlaps) {
              console.log('  OVERLAP with', g.id, 'type=' + g.gateType, 'at', g.absX, g.absY, g.width, g.height);
              console.log('    seg:', p0.x, p0.y, '->', p1.x, p1.y);
            }
          }
        }
      }
    }

    console.log('\nGates:');
    for (const g of l.nodes) {
      const outputs = g.outputs?.length ? g.outputs.map(o => `(${o.absX},${o.absY})`).join(', ') : 'none';
      console.log(' ', g.id, 'gateType=' + g.gateType, 'absX=' + g.absX, 'absY=' + g.absY, 'w=' + g.width, 'h=' + g.height, 'outputs:', outputs);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { layoutDiagram } from '../../src/renderer/layout.js';
import { parse } from '../../src/parser/index.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { estimateTextWidth } from '../../src/renderer/math-renderer.js';

// Bounding box of a boundary INPUT/OUTPUT node's rendered label (mirrors labels.ts ioLabelBoxes).
function ioBox(n: { gateType?: string; name?: string; label?: string; description?: string; inputs: { absX: number; absY: number }[]; outputs: { absX: number; absY: number }[] }) {
  const isIn = n.gateType === 'INPUT';
  const port = isIn ? n.outputs[0] : n.inputs[0];
  const text = n.name || n.label || '';
  const w = Math.max(estimateTextWidth(text, 12), n.description ? estimateTextWidth(n.description, 9) : 0);
  const top = n.description ? port.absY - 18 : port.absY - 9;
  const h = n.description ? 34 : 18;
  const x = isIn ? port.absX - 6 - w : port.absX + 6;
  return { x, y: top, w, h };
}

describe('net label placement (issue #21)', () => {
  // A consumed-intermediate net label must not land on a boundary port's own label — the case that
  // stacked "Zone A Occupied" on top of "Occupancy Sensor — Zone A" on the large demo diagrams.
  it('keeps net labels clear of boundary input/output labels', () => {
    const src = [
      'ALIAS = SENSOR',                              // pass-through alias; ALIAS gets a net label near SENSOR
      'GATE1 = ALIAS AND ENABLE',
      'GATE2 = ALIAS OR OVERRIDE',                   // ALIAS fans out -> a net label is drawn
      'SENSOR.Name = "Occupancy Sensor — Zone A"',
      'SENSOR.Description = "PIR sensor — TRUE if occupied"',
      'ALIAS.Name = "Zone A Occupied"',
    ].join('\n');
    const l = layoutDiagram(parse(src).diagram, resolveOptions([]));
    const ioBoxes = l.nodes.filter(n => n.gateType === 'INPUT' || n.gateType === 'OUTPUT').map(ioBox);
    for (const lb of l.labels) {
      for (const b of ioBoxes) {
        const overlap = lb.x + lb.width > b.x && b.x + b.w > lb.x && lb.y + lb.height > b.y && b.y + b.h > lb.y;
        expect(overlap, `net label "${lb.name}" overlaps a boundary label box`).toBe(false);
      }
    }
  });
});

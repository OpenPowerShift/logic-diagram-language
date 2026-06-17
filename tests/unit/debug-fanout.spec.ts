import { parse } from '../../src/parser/index.js';
import { layoutDiagram } from '../../src/renderer/layout.js';
import { EXAMPLES } from '../../src/examples.js';

describe('debug fanout', () => {
  it('Boolean Algebra', () => {
    const r = parse(EXAMPLES['Boolean Algebra']);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta);
    for (const w of l.wires) {
      let hasDiag = false;
      for (let i = 1; i < w.points.length; i++) {
        const p0 = w.points[i-1];
        const p1 = w.points[i];
        const dx = Math.abs(p1.x - p0.x);
        const dy = Math.abs(p1.y - p0.y);
        if (dx >= 1 && dy >= 1) hasDiag = true;
      }
      if (hasDiag) {
        console.log(`DIAG wire ${w.id} (${w.fromId} -> ${w.toId}):`);
        for (let i = 0; i < w.points.length; i++) {
          console.log(`  p${i}: (${w.points[i].x}, ${w.points[i].y})`);
        }
      }
    }
    // Check junctions
    console.log(`Junctions: ${l.junctions.length}`);
    for (const j of l.junctions) {
      console.log(`  junction at (${j.x}, ${j.y})`);
    }
  });

  it('Motor Control Circuit', () => {
    const r = parse(EXAMPLES['Motor Control Circuit']);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta);
    // Check for wires passing through gates
    const gates = l.nodes.filter(n => n.gateType !== 'INPUT' && n.gateType !== 'OUTPUT');
    for (const w of l.wires) {
      for (let i = 0; i < w.points.length - 1; i++) {
        const p0 = w.points[i];
        const p1 = w.points[i + 1];
        // Check each point (not just segments) against gate bodies
        for (const gate of gates) {
          // Skip if wire starts or ends at this gate
          if (w.fromId === gate.id || w.toId === gate.id) continue;
          for (const p of [p0, p1]) {
            if (p.x > gate.absX + 2 && p.x < gate.absX + gate.width - 2 &&
                p.y > gate.absY + 2 && p.y < gate.absY + gate.height - 2) {
              console.log(`Wire ${w.id} (${w.fromId} -> ${w.toId}) point inside gate ${gate.id}`);
            }
          }
        }
      }
    }
  });
});
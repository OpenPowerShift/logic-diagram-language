import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { buildGraph } from '../../src/renderer/graph.js';
import { resolveOptions } from '../../src/parser/ast.js';

function graphOf(src: string) {
  const r = parse(src);
  let i = 0;
  return buildGraph(r.diagram, resolveOptions(r.diagram.options), (p) => `${p}_${++i}`);
}

describe('buildGraph', () => {
  it('builds gates, inputs and an output for a simple expression', () => {
    const { nodes } = graphOf('OUT = A AND B');
    const kinds = [...nodes.values()].map(n => n.kind).sort();
    expect(kinds).toEqual(['gate', 'input', 'input', 'output']);
    const and = [...nodes.values()].find(n => n.gateType === 'AND')!;
    expect(and.inputIds).toHaveLength(2);
  });

  it('flattens associative AND/OR chains into one multi-input gate', () => {
    const { nodes } = graphOf('OUT = A AND B AND C AND D');
    const and = [...nodes.values()].find(n => n.gateType === 'AND')!;
    expect(and.inputIds).toHaveLength(4);
  });

  it('shares a consumed intermediate and does not draw it as an output', () => {
    const { nodes } = graphOf('A = X OR Y\nOUT = A AND Z');
    const outputs = [...nodes.values()].filter(n => n.kind === 'output').map(n => n.label);
    expect(outputs).toEqual(['OUT']); // A is consumed → not an output
  });

  it('forces a consumed intermediate to an output with .OUT = TRUE', () => {
    const { nodes } = graphOf('A = X OR Y\nOUT = A AND Z\nA.OUT = TRUE');
    const outputs = [...nodes.values()].filter(n => n.kind === 'output').map(n => n.label).sort();
    expect(outputs).toEqual(['A', 'OUT']);
  });

  it('emits a junction label for a consumed intermediate with metadata', () => {
    const { intermediateLabels } = graphOf('A = X OR Y\nOUT = A AND Z\nA.Name = "Permit"');
    expect(intermediateLabels.map(l => l.name)).toEqual(['Permit']);
  });

  it('absorbs NOT into a bubble under INVERSION = BUBBLES (no NOT node remains)', () => {
    const { nodes } = graphOf('OPTION INVERSION = BUBBLES\nOUT = A AND NOT B');
    expect([...nodes.values()].some(n => n.gateType === 'NOT')).toBe(false);
    const and = [...nodes.values()].find(n => n.gateType === 'AND')!;
    expect(and.invertedInputs && and.invertedInputs.size).toBe(1);
  });

  // Issue #16: a signal that shares its identifier with an explicit object id must not render its
  // .Name/.Description twice. Consumed intermediate -> object keeps it (no net label); shown output
  // -> output node keeps it (object's copy cleared).
  it('consumed-intermediate name colliding with a block id: object keeps label, no net label', () => {
    const { nodes, intermediateLabels } = graphOf(
      'X = FB#X(A, B).OUT\nY = TIMER(X, 0, 0)\nX.Name = "Voltage Check"',
    );
    // The FB block (its id is X) carries the label...
    const fb = [...nodes.values()].find(n => n.blockType === 'FB')!;
    expect(fb.name).toBe('Voltage Check');
    // ...and no duplicate net label is emitted for the same identifier.
    expect(intermediateLabels.some(l => l.name === 'Voltage Check')).toBe(false);
  });

  it('shown-output name colliding with a gate id: output keeps label, gate copy cleared', () => {
    const { nodes } = graphOf('TRIP = AND#TRIP(A, B)\nTRIP.Name = "Trip"');
    const output = [...nodes.values()].find(n => n.kind === 'output')!;
    const gate = [...nodes.values()].find(n => n.gateType === 'AND')!;
    expect(output.name).toBe('Trip');
    expect(gate.name).toBeUndefined();
  });

  it('no collision: a distinct block id leaves the net label intact', () => {
    const { intermediateLabels } = graphOf(
      'X = FB#VCHK(A, B).OUT\nY = TIMER(X, 0, 0)\nX.Name = "Voltage Check"',
    );
    expect(intermediateLabels.some(l => l.name === 'Voltage Check')).toBe(true);
  });
});

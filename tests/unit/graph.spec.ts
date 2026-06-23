import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { buildGraph } from '../../src/renderer/graph.js';
import { resolveOptions } from '../../src/parser/ast.js';

function graphOf(src: string) {
  const r = parse(src);
  let i = 0;
  return buildGraph(r.diagram, r.diagram.portMeta, resolveOptions(r.diagram.options), (p) => `${p}_${++i}`);
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
});

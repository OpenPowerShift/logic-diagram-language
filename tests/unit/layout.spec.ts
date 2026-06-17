import { describe, it, expect } from 'vitest';
import { layoutDiagram } from '../../src/renderer/layout.js';
import { parse } from '../../src/parser/index.js';
import { resolveOptions } from '../../src/parser/ast.js';

describe('Layout Engine', () => {
  it('lays out a simple AND gate', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const layout = layoutDiagram(result.diagram, result.diagram.portMeta);

    expect(layout.nodes.length).toBeGreaterThan(0);
    expect(layout.wires.length).toBeGreaterThan(0);

    const andGate = layout.nodes.find(n => n.gateType === 'AND');
    expect(andGate).toBeDefined();
  });

  it('lays out a NOT gate', () => {
    const result = parse('OUT = NOT A');
    expect(result.errors).toHaveLength(0);
    const layout = layoutDiagram(result.diagram, result.diagram.portMeta);

    const notGate = layout.nodes.find(n => n.gateType === 'NOT');
    const inputPort = layout.nodes.find(n => n.gateType === 'INPUT');
    expect(notGate).toBeDefined();
    expect(inputPort).toBeDefined();
  });

  it('lays out a combined expression with multiple layers', () => {
    const result = parse('CBFPS = AB AND DC OR (NOT DC AND GF)');
    expect(result.errors).toHaveLength(0);
    const layout = layoutDiagram(result.diagram, result.diagram.portMeta);

    const gates = layout.nodes.filter(n =>
      n.gateType === 'AND' || n.gateType === 'OR' || n.gateType === 'NOT'
    );
    expect(gates.length).toBeGreaterThanOrEqual(3);
  });

  it('assigns deeper nodes rightward', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const layout = layoutDiagram(result.diagram, result.diagram.portMeta);

    const inputs = layout.nodes.filter(n => n.gateType === 'INPUT');
    const andGate = layout.nodes.find(n => n.gateType === 'AND');

    for (const input of inputs) {
      expect(input.absX).toBeLessThan(andGate!.absX);
    }
  });

  it('includes port metadata in layout nodes', () => {
    const source = `I1.Name = "Test"
O1 = I1 AND I2`;
    const result = parse(source);
    expect(result.errors).toHaveLength(0);
    const layout = layoutDiagram(result.diagram, result.diagram.portMeta);

    const inputNode = layout.nodes.find(n => n.label === 'I1');
    expect(inputNode).toBeDefined();
    expect(inputNode!.name).toBe('Test');
  });

  it('wires connect from output ports to input ports', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const layout = layoutDiagram(result.diagram, result.diagram.portMeta);

    for (const wire of layout.wires) {
      expect(wire.points.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('input ports have absolute positions on left side', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const layout = layoutDiagram(result.diagram, result.diagram.portMeta);

    const inputs = layout.nodes.filter(n => n.gateType === 'INPUT');
    const andGate = layout.nodes.find(n => n.gateType === 'AND');

    for (const input of inputs) {
      expect(input.absX).toBeLessThan(andGate!.absX);
    }
  });
});

describe('Bubbles Mode - Input Bubbles', () => {
  it('places a bubble on the AND input when NOT feeds AND', () => {
    const r = parse('OPTION INVERSION = BUBBLES\nO1 = I1 AND NOT I2');
    const opts = resolveOptions(r.diagram.options);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta, opts);

    const andGate = l.nodes.find(n => n.gateType === 'AND');
    expect(andGate).toBeDefined();
    const bubbledInput = andGate!.inputs.find(p => p.bubbled);
    expect(bubbledInput).toBeDefined();
    const normalInput = andGate!.inputs.find(p => !p.bubbled);
    expect(normalInput).toBeDefined();

    const notGate = l.nodes.find(n => n.gateType === 'NOT');
    expect(notGate).toBeUndefined();
  });

  it('shifts bubbled input port left by BUBBLE_R * 2', () => {
    const r = parse('OPTION INVERSION = BUBBLES\nO1 = I1 AND NOT I2');
    const opts = resolveOptions(r.diagram.options);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta, opts);

    const andGate = l.nodes.find(n => n.gateType === 'AND');
    const normalInput = andGate!.inputs.find(p => !p.bubbled)!;
    const bubbledInput = andGate!.inputs.find(p => p.bubbled)!;

    expect(normalInput.absX - bubbledInput.absX).toBe(10);
  });
});

describe('Bubbles Mode - Output Bubbles', () => {
  it('places a bubble on the AND output when NOT wraps AND', () => {
    const r = parse('OPTION INVERSION = BUBBLES\nO1 = NOT (I1 AND I2)');
    const opts = resolveOptions(r.diagram.options);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta, opts);

    const andGate = l.nodes.find(n => n.gateType === 'AND');
    expect(andGate).toBeDefined();
    expect(andGate!.outputs[0].bubbledOutput).toBe(true);

    const notGate = l.nodes.find(n => n.gateType === 'NOT');
    expect(notGate).toBeUndefined();
  });

  it('places a bubble on output node when NOT feeds output directly', () => {
    const r = parse('OPTION INVERSION = BUBBLES\nO1 = NOT I1');
    const opts = resolveOptions(r.diagram.options);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta, opts);

    const outNode = l.nodes.find(n => n.gateType === 'OUTPUT');
    expect(outNode).toBeDefined();
    expect(outNode!.inputs[0].bubbled).toBe(true);

    const notGate = l.nodes.find(n => n.gateType === 'NOT');
    expect(notGate).toBeUndefined();
  });

  it('shifts bubbled output port right by BUBBLE_R * 2', () => {
    const r = parse('OPTION INVERSION = BUBBLES\nO1 = NOT (I1 AND I2)');
    const opts = resolveOptions(r.diagram.options);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta, opts);

    const andGate = l.nodes.find(n => n.gateType === 'AND');
    const andRightEdge = andGate!.absX + andGate!.width;
    expect(andGate!.outputs[0].absX).toBe(andRightEdge + 10);
  });
});

describe('Bubbles Mode - Double Inversion Cancellation', () => {
  it('NOT NOT I1: double inversion cancels, no bubbles', () => {
    const r = parse('OPTION INVERSION = BUBBLES\nO1 = NOT NOT I1');
    const opts = resolveOptions(r.diagram.options);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta, opts);

    const notGate = l.nodes.find(n => n.gateType === 'NOT');
    expect(notGate).toBeUndefined();

    const outNode = l.nodes.find(n => n.gateType === 'OUTPUT');
    expect(outNode!.inputs[0].bubbled).toBeUndefined();

    const inputNode = l.nodes.find(n => n.gateType === 'INPUT');
    expect(inputNode!.outputs[0].bubbledOutput).toBeUndefined();
  });

  it('NOT NOT (I1 AND I2): double inversion on gate cancels, no bubbles', () => {
    const r = parse('OPTION INVERSION = BUBBLES\nO1 = NOT NOT (I1 AND I2)');
    const opts = resolveOptions(r.diagram.options);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta, opts);

    const andGate = l.nodes.find(n => n.gateType === 'AND');
    expect(andGate!.outputs[0].bubbledOutput).toBeUndefined();
    expect(andGate!.inputs.find(p => p.bubbled)).toBeUndefined();
  });

  it('I1 AND NOT NOT I2: double inversion on input cancels, no bubble', () => {
    const r = parse('OPTION INVERSION = BUBBLES\nO1 = I1 AND NOT NOT I2');
    const opts = resolveOptions(r.diagram.options);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta, opts);

    const andGate = l.nodes.find(n => n.gateType === 'AND');
    expect(andGate!.inputs.find(p => p.bubbled)).toBeUndefined();
  });

  it('NOT NOT NOT I1: triple inversion reduces to single bubble', () => {
    const r = parse('OPTION INVERSION = BUBBLES\nO1 = NOT NOT NOT I1');
    const opts = resolveOptions(r.diagram.options);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta, opts);

    const outNode = l.nodes.find(n => n.gateType === 'OUTPUT');
    expect(outNode!.inputs[0].bubbled).toBe(true);
  });

  it('NOT NOT NOT (I1 AND I2): triple inversion on AND = one output bubble', () => {
    const r = parse('OPTION INVERSION = BUBBLES\nO1 = NOT NOT NOT (I1 AND I2)');
    const opts = resolveOptions(r.diagram.options);
    const l = layoutDiagram(r.diagram, r.diagram.portMeta, opts);

    const andGate = l.nodes.find(n => n.gateType === 'AND');
    expect(andGate!.outputs[0].bubbledOutput).toBe(true);
  });
});
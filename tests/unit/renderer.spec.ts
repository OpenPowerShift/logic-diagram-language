import { describe, it, expect } from 'vitest';
import { renderDiagram } from '../../src/renderer/svg-renderer.js';
import { parse } from '../../src/parser/index.js';

describe('SVG Renderer', () => {
  it('renders a simple AND gate expression', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram, result.diagram.portMeta);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('renders a simple OR gate expression', () => {
    const result = parse('OUT = A OR B');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram, result.diagram.portMeta);
    expect(svg).toContain('ldl-gate-or');
  });

  it('renders a NOT gate expression', () => {
    const result = parse('OUT = NOT A');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram, result.diagram.portMeta);
    expect(svg).toContain('ldl-gate-not');
  });

  it('renders a combined expression with AND, OR, NOT', () => {
    const result = parse('CBFPS = AB AND DC OR (NOT DC AND GF)');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram, result.diagram.portMeta);
    expect(svg).toContain('<svg');
  });

  it('renders wires between elements', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram, result.diagram.portMeta);
    expect(svg).toContain('ldl-wire');
  });

  it('renders port labels from .Name metadata', () => {
    const source = `I1.Name = "Test Input"
O1 = I1 AND I2`;
    const result = parse(source);
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram, result.diagram.portMeta, true);
    expect(svg).toContain('ldl-name');
    expect(svg).toContain('Test Input');
  });

  it('renders port descriptions from .Description metadata', () => {
    const source = `I1.Description = "(BI 3.1)"
O1 = I1 AND I2`;
    const result = parse(source);
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram, result.diagram.portMeta, true);
    expect(svg).toContain('ldl-description');
    expect(svg).toContain('(BI 3.1)');
  });

  it('includes label visibility classes', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram, result.diagram.portMeta, true);
    expect(svg).toContain('ldl-show-labels');
  });

  it('renders gates with absolute port positions', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram, result.diagram.portMeta);
    // Check for port circles with cx/cy (absolute positioning)
    expect(svg).toContain('ldl-port');
    expect(svg).toContain('r="3"');
  });
});
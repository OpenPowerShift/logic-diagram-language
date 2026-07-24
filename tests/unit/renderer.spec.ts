import { describe, it, expect } from 'vitest';
import { renderDiagram } from '../../src/renderer/svg-renderer.js';
import { parse } from '../../src/parser/index.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { EXAMPLES } from '../../src/examples.js';

describe('SVG Renderer', () => {
  it('renders a simple AND gate expression', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('renders a simple OR gate expression', () => {
    const result = parse('OUT = A OR B');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram);
    expect(svg).toContain('ldl-gate-or');
  });

  it('renders a NOT gate expression', () => {
    const result = parse('OUT = NOT A');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram);
    expect(svg).toContain('ldl-gate-not');
  });

  it('renders a combined expression with AND, OR, NOT', () => {
    const result = parse('CBFPS = AB AND DC OR (NOT DC AND GF)');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram);
    expect(svg).toContain('<svg');
  });

  it('renders wires between elements', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram);
    expect(svg).toContain('ldl-wire');
  });

  it('renders port labels from .Name metadata', () => {
    const source = `I1.Name = "Test Input"
O1 = I1 AND I2`;
    const result = parse(source);
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram);
    expect(svg).toContain('ldl-name');
    expect(svg).toContain('Test Input');
  });

  it('renders port descriptions from .Description metadata', () => {
    const source = `I1.Description = "(BI 3.1)"
O1 = I1 AND I2`;
    const result = parse(source);
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram);
    expect(svg).toContain('ldl-description');
    expect(svg).toContain('(BI 3.1)');
  });

  it('includes label visibility classes', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram);
    expect(svg).toContain('ldl-show-labels');
  });

  it('renders gates with absolute port positions', () => {
    const result = parse('OUT = A AND B');
    expect(result.errors).toHaveLength(0);
    const svg = renderDiagram(result.diagram);
    // Check for port circles with cx/cy (absolute positioning)
    expect(svg).toContain('ldl-port');
    expect(svg).toContain('r="3"');
  });
});

// Guard: every wire's data-from/data-to must reference a valid SVG node id (Item 9 introduced
// user-facing ids on SVG nodes, distinct from internal ids — if the wires still reference
// internal ids the DOM linkage is broken and diagrams appear with "ungated" wires).
describe('SVG wire-node linkage', () => {
  for (const [name, src] of Object.entries(EXAMPLES)) {
    it(`${name}: wires reference valid SVG node ids`, () => {
      const r = parse(src);
      const svg = renderDiagram(r.diagram, resolveOptions(r.diagram.options));
      const nodeIds = new Set([...svg.matchAll(/<g class="ldl-symbol[^"]*" id="([^"]+)" /g)].map(m => m[1]));
      const froms = [...svg.matchAll(/data-from="([^"]+)"/g)].map(m => m[1]);
      const tos = [...svg.matchAll(/data-to="([^"]+)"/g)].map(m => m[1]);
      for (const f of froms) expect(nodeIds.has(f), `${name}: wire data-from="${f}" has no matching SVG node id`).toBe(true);
      for (const t of tos) expect(nodeIds.has(t), `${name}: wire data-to="${t}" has no matching SVG node id`).toBe(true);
    });
  }
});

// OPTION PORT_STYLE = NONE — the "streamlined" view: suppress every terminal marker
// (boundary ports + gate/block pins) while leaving junction/crossover dots intact.
describe('PORT_STYLE = NONE (streamlined view)', () => {
  it('emits no port markers but keeps junction (crossover) dots', () => {
    // SHARED fans out to two outputs -> a junction dot; A/B/C/D are boundary ports.
    const r = parse('OPTION PORT_STYLE = NONE\nSHARED = A AND B\nO1 = SHARED AND C\nO2 = SHARED OR D');
    expect(r.errors).toHaveLength(0);
    const svg = renderDiagram(r.diagram, resolveOptions(r.diagram.options));
    expect(svg).not.toContain('class="ldl-port');    // no terminal dots
    expect(svg).toContain('ldl-junction-group');     // crossover dots remain
  });

  it('still draws port markers by default (CIRCLE)', () => {
    const svg = renderDiagram(parse('O = A AND B').diagram, resolveOptions(parse('O = A AND B').diagram.options));
    expect(svg).toContain('class="ldl-port');
  });
});
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

// TeX math ($...$) must typeset in every centred label — function-block and named-gate
// names/descriptions and net (wire) labels — the same way it already does for port labels.
// Regression for labels that previously emitted the raw `$...$` source as plain text.
describe('math in block / gate / wire labels', () => {
  it('renders block description math as typeset SVG, not raw TeX', () => {
    const r = parse('O = FB#B(X, Y).OUT\nB.Description = "$\\frac{a}{b}$"');
    expect(r.errors).toHaveLength(0);
    const svg = renderDiagram(r.diagram, resolveOptions(r.diagram.options));
    expect(svg).toContain('class="ldl-math"');   // typeset math group present
    expect(svg).not.toContain('$\\frac');        // raw TeX not leaked as text
  });

  it('renders net (wire) label math as typeset SVG', () => {
    // INT is consumed below -> a net label is drawn on the wire.
    const r = parse('INT = A AND B\nO = INT OR C\nINT.Name = "$I_a$"');
    expect(r.errors).toHaveLength(0);
    const svg = renderDiagram(r.diagram, resolveOptions(r.diagram.options));
    expect(svg).toContain('ldl-net-label');
    expect(svg).toContain('class="ldl-math"');
  });

  it('produces well-formed XML for math containing a "<" relation', () => {
    const r = parse('O = FB#B(X, Y).OUT\nB.Description = "$a < b$"');
    const svg = renderDiagram(r.diagram, resolveOptions(r.diagram.options));
    // A raw "<" inside an attribute value is valid HTML but invalid XML/SVG (breaks
    // rsvg/PDF export). No attribute value may contain an unescaped "<".
    expect(svg).not.toMatch(/="[^"]*<[^"]*"/);
  });
});
import { describe, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'fs';
import { parse } from '../../src/parser/index.js';
import { renderDiagram } from '../../src/renderer/svg-renderer.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { EXAMPLES } from '../../src/examples.js';

describe('render examples to SVG', () => {
  it('renders all', () => {
    mkdirSync('/tmp/ldl-render', { recursive: true });
    for (const [name, src] of Object.entries(EXAMPLES)) {
      const r = parse(src);
      const opts = resolveOptions(r.diagram.options);
      const svg = renderDiagram(r.diagram, true, false, opts);
      const fn = name.replace(/[^a-z0-9]/gi, '_');
      writeFileSync(`/tmp/ldl-render/${fn}.svg`, svg);
      console.log('wrote', fn);
    }
  });
});

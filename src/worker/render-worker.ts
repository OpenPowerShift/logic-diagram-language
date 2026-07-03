// Off-main-thread parse → layout → render → validate. The heavy layoutDiagram/renderDiagram work
// (which grew with the candidate-based layout) used to run on the UI thread on every edit, making the
// editor stutter on a slow diagram. Running it here keeps typing smooth: the editor stays on the main
// thread and this worker posts back the finished SVG. Everything on this path is DOM-free (MathJax
// uses its liteAdaptor), so it runs unchanged in a Worker.
import { parse } from '../parser/index.js';
import { resolveOptions } from '../parser/ast.js';
import { renderDiagram } from '../renderer/svg-renderer.js';
import { layoutDiagram } from '../renderer/layout.js';
import { validateLayout, type CheckResult } from '../renderer/checks.js';
import type { DiagramTheme } from '../theme/themes.js';

export interface RenderRequest {
  id: number;
  source: string;
  showLabels: boolean;
  showIds: boolean;
  hideJunctions: boolean;
  theme: DiagramTheme;
}
export interface RenderResponse {
  id: number;
  svg: string;
  checks: CheckResult[];
  parseErrors: { message: string; line: number; column: number }[];
}

self.onmessage = (e: MessageEvent<RenderRequest>) => {
  const { id, source, showLabels, showIds, hideJunctions, theme } = e.data;
  let res: RenderResponse;
  try {
    const result = parse(source);
    if (result.diagram.outputs.length > 0) {
      const opts = resolveOptions(result.diagram.options);
      opts.hideJunctions = hideJunctions || opts.hideJunctions;
      const layout = layoutDiagram(result.diagram, result.diagram.portMeta, opts);
      const checks = validateLayout(layout);
      const svg = renderDiagram(result.diagram, result.diagram.portMeta, showLabels, showIds, opts, theme);
      res = { id, svg, checks, parseErrors: result.errors };
    } else {
      res = { id, svg: '', checks: [], parseErrors: result.errors };
    }
  } catch (err) {
    res = { id, svg: '', checks: [], parseErrors: [{ message: (err as Error).message, line: 0, column: 0 }] };
  }
  (self as unknown as Worker).postMessage(res);
};

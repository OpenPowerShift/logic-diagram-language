import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { parse } from '../parser/index.js';
import { resolveOptions, DEFAULT_OPTIONS } from '../parser/ast.js';
import type { RenderOptions } from '../parser/ast.js';
import { renderDiagram } from '../renderer/svg-renderer.js';
import { EXAMPLES, EXAMPLE_NAMES } from '../examples.js';
import './ldl-editor.js';
import './ldl-viewer.js';

@customElement('ldl-app')
export class LdlApp extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
      background: #f5f6fa;
      color: #2c3e50;
      font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      background: #2c3e50;
      border-bottom: 2px solid #1a252f;
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .toolbar-title {
      font-size: 15px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: 1px;
    }
    .toolbar-sep {
      width: 1px;
      height: 20px;
      background: rgba(255,255,255,0.25);
    }
    select {
      background: #1a252f;
      color: #ffffff;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      outline: none;
    }
    select:hover {
      border-color: rgba(255,255,255,0.4);
    }
    select:focus {
      border-color: #3498db;
    }
    .main {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .pane-left {
      width: 45%;
      min-width: 280px;
      max-width: 55%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-right: 2px solid #dce1e8;
    }
    .pane-right {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    ldl-viewer {
      flex: 1;
      min-height: 0;
    }
    ldl-editor {
      flex: 1;
      min-height: 0;
    }
  `;

  @state() private svg = '';
  @state() private parseErrors: { message: string; line: number; column: number }[] = [];
  @state() private currentExample = 'Simple AND Gate';
  @state() private sourceText = EXAMPLES['Simple AND Gate'];
  @state() private showLabels = true;
  @state() private showIds = false;

  connectedCallback() {
    super.connectedCallback();
    this.updateDiagram(this.sourceText);
  }

  private handleExampleChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const name = select.value;
    if (EXAMPLES[name]) {
      this.currentExample = name;
      this.sourceText = EXAMPLES[name];
      this.updateDiagram(this.sourceText);
    }
  }

  private handleSourceChange(e: Event) {
    const source = (e as CustomEvent).detail?.value ?? '';
    this.sourceText = source;
    this.updateDiagram(source);
  }

  private handleToggleLabels() {
    this.showLabels = !this.showLabels;
    this.updateDiagram(this.sourceText);
  }

  private handleToggleIds() {
    this.showIds = !this.showIds;
    this.updateDiagram(this.sourceText);
  }

  private handleDownloadSvg() {
    if (!this.svg) return;
    const blob = new Blob([this.svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diagram.svg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private handleExportPdf() {
    if (!this.svg) return;
    const parser = new DOMParser();
    const doc = parser.parseFromString(this.svg, 'image/svg+xml');
    const svgEl = doc.documentElement;
    const vb = svgEl.getAttribute('viewBox')?.split(' ').map(Number) ?? [0, 0, 800, 400];
    const svgW = vb[2];
    const svgH = vb[3];

    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = svgW * scale;
    canvas.height = svgH * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const svgData = new XMLSerializer().serializeToString(svgEl);
    const imgSrc = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
    const img = new Image();
    img.onload = async () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const { jsPDF } = await import('jspdf');
      const orientation = svgW > svgH ? 'landscape' : 'portrait';
      const pdf = new jsPDF({ orientation, unit: 'px', format: [svgW, svgH] });
      const imgData = canvas.toDataURL('image/png');
      pdf.addImage(imgData, 'PNG', 0, 0, svgW, svgH);
      pdf.save('diagram.pdf');
    };
    img.src = imgSrc;
  }

  private updateDiagram(source: string) {
    try {
      const result = parse(source);
      this.parseErrors = result.errors;
      if (result.diagram.outputs.length > 0) {
        const options = resolveOptions(result.diagram.options);
        this.svg = renderDiagram(result.diagram, result.diagram.portMeta, this.showLabels, this.showIds, options);
      } else {
        this.svg = '';
      }
    } catch (err: any) {
      this.parseErrors = [{ message: err.message, line: 0, column: 0 }];
      this.svg = '';
    }
  }

  render() {
    return html`
      <div class="toolbar">
        <span class="toolbar-title">LDL</span>
        <div class="toolbar-sep"></div>
        <label for="example-select" style="font-size:12px;color:#b0bec5;">Example:</label>
        <select id="example-select" .value=${this.currentExample} @change=${this.handleExampleChange}>
          ${EXAMPLE_NAMES.map(name => html`<option value=${name} ?selected=${name === this.currentExample}>${name}</option>`)}
        </select>
      </div>
      <div class="main">
        <div class="pane-left">
          <ldl-editor
            .value=${this.sourceText}
            .errors=${this.parseErrors}
            @ldl-change=${this.handleSourceChange}
          ></ldl-editor>
        </div>
        <div class="pane-right">
          <ldl-viewer
            .svg=${this.svg}
            .showLabels=${this.showLabels}
            .showIds=${this.showIds}
            @toggle-labels=${this.handleToggleLabels}
            @toggle-ids=${this.handleToggleIds}
            @download-svg=${this.handleDownloadSvg}
            @export-pdf=${this.handleExportPdf}
          ></ldl-viewer>
        </div>
      </div>
    `;
  }
}
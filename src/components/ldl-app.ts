import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { parse } from '../parser/index.js';
import { resolveOptions, DEFAULT_OPTIONS } from '../parser/ast.js';
import type { Diagram, RenderOptions } from '../parser/ast.js';
import { renderDiagram } from '../renderer/svg-renderer.js';
import { layoutDiagram } from '../renderer/layout.js';
import { validateLayout, type CheckResult } from '../renderer/checks.js';
import { EXAMPLES, EXAMPLE_NAMES } from '../examples.js';
import type { AppTheme, DiagramTheme } from '../theme/themes.js';
import { LIGHT_THEME, DARK_THEME, LIGHT_DIAGRAM } from '../theme/themes.js';
import { getCurrentTheme, onThemeChange } from '../theme/theme-observer.js';
import './ldl-editor.js';
import './ldl-viewer.js';               // side-effect: registers the <ldl-viewer> custom element
import type { LdlViewer } from './ldl-viewer.js'; // type only (used for the viewer() accessor)

@customElement('ldl-app')
export class LdlApp extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      height: 100dvh; /* dynamic viewport height so mobile browser chrome doesn't clip the app */
      width: 100vw;
      overflow: hidden;
      background: var(--ldl-bg);
      color: var(--ldl-text);
      font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      background: var(--ldl-toolbar-bg);
      border-bottom: 2px solid var(--ldl-toolbar-dark);
      flex: 0 0 auto;
      flex-wrap: wrap;
      z-index: 10;
    }
    .toolbar-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--ldl-toolbar-text);
      letter-spacing: 1px;
    }
    .toolbar-sep {
      width: 1px;
      height: 20px;
      background: var(--ldl-toolbar-separator);
    }
    select {
      background: var(--ldl-toolbar-dark);
      color: var(--ldl-toolbar-text);
      border: 1px solid var(--ldl-toolbar-border-alpha20);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      outline: none;
    }
    select:hover {
      border-color: var(--ldl-toolbar-border-alpha40);
    }
    select:focus {
      border-color: var(--ldl-accent);
    }
    .main {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .pane-left {
      width: 45%;
      min-width: 280px;
      max-width: 55%;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      border-right: 2px solid var(--ldl-border);
    }
    .pane-right {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
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
    .checks-panel {
      flex: 0 0 auto;
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      padding: 6px 12px;
      background: var(--ldl-toolbar-bg);
      border-top: 1px solid var(--ldl-toolbar-dark);
      font-size: 11px;
      font-family: 'JetBrains Mono', 'Consolas', monospace;
    }
    .check {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--ldl-toolbar-text);
    }
    .check-mark {
      font-weight: 700;
    }
    .check.ok .check-mark {
      color: #2e9e5b;
    }
    .check.fail {
      color: #d14;
    }
    .check.fail .check-mark {
      color: #d14;
    }
    .check-detail {
      opacity: 0.7;
    }
    /* Right-aligned group in the toolbar: the diagram controls (and, on mobile, the Code/Diagram
       toggle). Moving the controls here means the diagram pane is all diagram — no header row, so it
       reclaims the vertical space that used to sit blank above the old "Diagram" bar. */
    .toolbar-right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .diagram-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .diagram-controls button,
    .diagram-controls .png-scale {
      background: var(--ldl-toolbar-dark);
      color: var(--ldl-toolbar-text);
      border: 1px solid var(--ldl-toolbar-border-alpha20);
      border-radius: 3px;
      padding: 3px 9px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
      outline: none;
    }
    .diagram-controls button:hover:not(:disabled),
    .diagram-controls .png-scale:hover {
      background: var(--ldl-toolbar-bg);
      border-color: var(--ldl-toolbar-border-alpha40);
    }
    .diagram-controls button.active {
      background: var(--ldl-accent);
      border-color: var(--ldl-accent);
      color: #fff;
    }
    .diagram-controls button:disabled,
    .diagram-controls .png-scale:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .diagram-controls .zoom-label {
      font-size: 11px;
      color: var(--ldl-toolbar-text);
      opacity: 0.7;
      min-width: 42px;
      text-align: center;
    }
    .diagram-controls .sep {
      width: 1px;
      height: 16px;
      background: var(--ldl-toolbar-separator);
    }
    /* Mobile Code/Diagram toggle — hidden on desktop (both panes show side by side). */
    .view-tabs {
      display: none;
      gap: 0;
    }
    .view-tabs button {
      background: var(--ldl-toolbar-dark);
      color: var(--ldl-toolbar-text);
      border: 1px solid var(--ldl-toolbar-border-alpha20);
      padding: 5px 14px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      outline: none;
    }
    .view-tabs button:first-child { border-radius: 4px 0 0 4px; }
    .view-tabs button:last-child { border-radius: 0 4px 4px 0; border-left: none; }
    .view-tabs button.active {
      background: var(--ldl-accent);
      border-color: var(--ldl-accent);
      color: #fff;
    }
    /* Below the breakpoint the panes stack full-width and only the selected one shows; the tabs
       switch between them. Rotating the device changes the pane size, which the viewer's
       ResizeObserver picks up to re-fit the diagram. */
    @media (max-width: 820px) {
      .view-tabs { display: inline-flex; }
      .main { flex-direction: column; }
      .pane-left, .pane-right {
        width: 100%;
        max-width: none;
        min-width: 0;
        flex: 1 1 auto;
        border-right: none;
      }
      .pane-left[hidden], .pane-right[hidden] { display: none; }
    }
  `;

  @state() private svg = '';
  @state() private checks: CheckResult[] = [];
  @state() private parseErrors: { message: string; line: number; column: number }[] = [];
  @state() private currentExample = 'Simple AND Gate';
  @state() private sourceText = EXAMPLES['Simple AND Gate'];
  @state() private modified = false;
  @state() private showLabels = true;
  @state() private showIds = false;
  @state() private hideJunctions = false;
  @state() private currentTheme: AppTheme = getCurrentTheme();
  // Mobile: below the breakpoint the panes stack and only one shows at a time.
  private static readonly NARROW_MQ = '(max-width: 820px)';
  @state() private isNarrow = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia(LdlApp.NARROW_MQ).matches : false;
  @state() private mobileView: 'code' | 'diagram' = 'diagram';
  @state() private zoomPct = 100; // published by the viewer; shown in the toolbar

  private unsubscribeTheme: (() => void) | null = null;
  private narrowMq: MediaQueryList | null = null;
  private narrowHandler: ((e: MediaQueryListEvent) => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.applyUITheme();
    this.loadState();
    this.unsubscribeTheme = onThemeChange((theme) => {
      this.currentTheme = theme;
      this.applyUITheme();
      this.updateDiagram(this.sourceText);
    });
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.narrowMq = window.matchMedia(LdlApp.NARROW_MQ);
      this.narrowHandler = (e) => { this.isNarrow = e.matches; };
      this.narrowMq.addEventListener('change', this.narrowHandler);
    }
    this.updateDiagram(this.sourceText);
  }

  // Persist the current diagram so a reload/rebuild restores it. An unmodified example is
  // re-loaded from its (possibly updated) definition; a modified diagram keeps the user's edits.
  private static STORAGE_KEY = 'ldl-diagram-state';

  private loadState() {
    try {
      const raw = localStorage.getItem(LdlApp.STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as { example?: string; source?: string; modified?: boolean };
      if (s.modified && typeof s.source === 'string') {
        this.sourceText = s.source;
        if (s.example && EXAMPLES[s.example]) this.currentExample = s.example;
        this.modified = true;
      } else if (s.example && EXAMPLES[s.example]) {
        this.currentExample = s.example;
        this.sourceText = EXAMPLES[s.example];
        this.modified = false;
      }
    } catch { /* ignore unavailable/corrupt storage */ }
  }

  private saveState() {
    try {
      localStorage.setItem(LdlApp.STORAGE_KEY, JSON.stringify({
        example: this.currentExample, source: this.sourceText, modified: this.modified,
      }));
    } catch { /* ignore unavailable storage */ }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.unsubscribeTheme) {
      this.unsubscribeTheme();
      this.unsubscribeTheme = null;
    }
    if (this.narrowMq && this.narrowHandler) {
      this.narrowMq.removeEventListener('change', this.narrowHandler);
      this.narrowMq = null;
      this.narrowHandler = null;
    }
    if (this.editDebounce !== null) { clearTimeout(this.editDebounce); this.editDebounce = null; }
  }

  private applyUITheme() {
    const ui = this.currentTheme.ui;
    this.style.setProperty('--ldl-bg', ui.bg);
    this.style.setProperty('--ldl-text', ui.text);
    this.style.setProperty('--ldl-toolbar-bg', ui.toolbarBg);
    this.style.setProperty('--ldl-toolbar-dark', ui.toolbarDark);
    this.style.setProperty('--ldl-accent', ui.accent);
    this.style.setProperty('--ldl-border', ui.border);
    this.style.setProperty('--ldl-toolbar-text', ui.toolbarText);
    this.style.setProperty('--ldl-toolbar-separator', ui.toolbarSeparator);
    this.style.setProperty('--ldl-toolbar-border-alpha20', ui.toolbarBorderAlpha20);
    this.style.setProperty('--ldl-toolbar-border-alpha40', ui.toolbarBorderAlpha40);
  }

  private handleExampleChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const name = select.value;
    if (EXAMPLES[name]) {
      if (this.editDebounce !== null) { clearTimeout(this.editDebounce); this.editDebounce = null; }
      this.currentExample = name;
      this.sourceText = EXAMPLES[name];
      this.modified = false;
      this.saveState();
      this.updateDiagram(this.sourceText);
    }
  }

  private editDebounce: ReturnType<typeof setTimeout> | null = null;

  private handleSourceChange(e: Event) {
    const source = (e as CustomEvent).detail?.value ?? '';
    this.sourceText = source;
    this.modified = source !== EXAMPLES[this.currentExample];
    // Debounce the expensive parse → layout → render so typing stays smooth on large diagrams.
    if (this.editDebounce !== null) clearTimeout(this.editDebounce);
    this.editDebounce = setTimeout(() => {
      this.editDebounce = null;
      this.saveState();
      this.updateDiagram(this.sourceText);
    }, 200);
  }

  private setMobileView(view: 'code' | 'diagram') {
    this.mobileView = view;
    // The viewer's own ResizeObserver re-fits when its pane goes from hidden (0px) to visible, so
    // switching to the diagram tab always lands it fitted to the current orientation.
  }

  // The diagram controls live in the top toolbar (so the viewer pane is all diagram, no header row).
  // Zoom/fit are driven by calling the viewer's public methods; the viewer publishes the zoom %.
  // Optional-call the methods (`?.()`): during dev HMR a custom element can't be re-`define`d, so an
  // existing <ldl-viewer> instance may briefly be the previous class without these methods — guard
  // against that instead of throwing (a full reload restores the current class).
  private viewer(): LdlViewer | null { return this.shadowRoot?.querySelector('ldl-viewer') as LdlViewer | null; }
  private handleZoomIn() { this.viewer()?.zoomIn?.(); }
  private handleZoomOut() { this.viewer()?.zoomOut?.(); }
  private handleFit() { this.viewer()?.fit?.(); }
  private handleZoomChange(e: Event) { this.zoomPct = (e as CustomEvent).detail?.pct ?? this.zoomPct; }

  private handleToggleLabels() {
    this.showLabels = !this.showLabels;
    this.updateDiagram(this.sourceText);
  }

  private handleToggleIds() {
    this.showIds = !this.showIds;
    this.updateDiagram(this.sourceText);
  }

  private handleToggleDots() {
    this.hideJunctions = !this.hideJunctions;
    this.updateDiagram(this.sourceText);
  }

  private handleDownloadSvg() {
    if (!this.svg) return;
    const printSvg = this.getPrintSvg();
    const blob = new Blob([printSvg], { type: 'image/svg+xml' });
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
    const printSvg = this.getPrintSvg();
    if (!printSvg) return;
    const parser = new DOMParser();
    const doc = parser.parseFromString(printSvg, 'image/svg+xml');
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

  // PNG DPI selector in the toolbar. Reads the chosen scale and resets the select so PNG can be
  // picked again (it has no persistent value).
  private handlePngScaleChange(e: Event) {
    const sel = e.target as HTMLSelectElement;
    const scale = parseInt(sel.value || '2', 10);
    sel.selectedIndex = 0;
    if (this.svg) this.handleExportPng(scale);
  }

  // Tier 4.13: PNG export at a user-selected DPI (1x, 2x, 3x, 4x). Reuses the same SVG-to-canvas
  // pipeline as the PDF export but skips the jsPDF step and writes the PNG directly.
  private handleExportPng(scale: number) {
    const printSvg = this.getPrintSvg();
    if (!printSvg) return;
    const parser = new DOMParser();
    const doc = parser.parseFromString(printSvg, 'image/svg+xml');
    const svgEl = doc.documentElement;
    const vb = svgEl.getAttribute('viewBox')?.split(' ').map(Number) ?? [0, 0, 800, 400];
    const svgW = vb[2];
    const svgH = vb[3];

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(svgW * scale));
    canvas.height = Math.max(1, Math.round(svgH * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const svgData = new XMLSerializer().serializeToString(svgEl);
    const imgSrc = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `diagram@${scale}x.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 'image/png');
    };
    img.src = imgSrc;
  }

  // Toolbar toggles override the diagram-source options for the live preview. The "live" options
  // carry the toolbar's hideJunctions setting so the SVG class flips; the "print" options don't
  // (the export reflects only the diagram's own OPTION HIDE_JUNCTIONS).
  private liveOptions(diagram: Diagram): RenderOptions {
    const opts = resolveOptions(diagram.options);
    opts.hideJunctions = this.hideJunctions || opts.hideJunctions;
    return opts;
  }

  private getPrintSvg(): string {
    try {
      const result = parse(this.sourceText);
      if (result.diagram.outputs.length > 0) {
        return renderDiagram(result.diagram, result.diagram.portMeta, this.showLabels, this.showIds, this.liveOptions(result.diagram), LIGHT_DIAGRAM);
      }
    } catch { /* fall through to cached svg */ }
    return this.svg;
  }

  private updateDiagram(source: string) {
    try {
      const result = parse(source);
      this.parseErrors = result.errors;
      if (result.diagram.outputs.length > 0) {
        const options = this.liveOptions(result.diagram);
        const layout = layoutDiagram(result.diagram, result.diagram.portMeta, options);
        this.checks = validateLayout(layout);
        this.svg = renderDiagram(result.diagram, result.diagram.portMeta, this.showLabels, this.showIds, options, this.currentTheme.diagram);
      } else {
        this.svg = '';
        this.checks = [];
      }
    } catch (err: any) {
      this.parseErrors = [{ message: err.message, line: 0, column: 0 }];
      this.svg = '';
      this.checks = [];
    }
  }

  render() {
    return html`
      <div class="toolbar">
        <span class="toolbar-title">LDL</span>
        <div class="toolbar-sep"></div>
        <label for="example-select" style="font-size:12px;color:${this.currentTheme.ui.textDim};">Example:</label>
        <select id="example-select" .value=${this.currentExample} @change=${this.handleExampleChange}>
          ${EXAMPLE_NAMES.map(name => html`<option value=${name} ?selected=${name === this.currentExample}>${name}</option>`)}
        </select>
        <div class="toolbar-right">
          <div class="view-tabs" role="tablist">
            <button role="tab" class=${this.mobileView === 'code' ? 'active' : ''} aria-selected=${this.mobileView === 'code'} @click=${() => this.setMobileView('code')}>Code</button>
            <button role="tab" class=${this.mobileView === 'diagram' ? 'active' : ''} aria-selected=${this.mobileView === 'diagram'} @click=${() => this.setMobileView('diagram')}>Diagram</button>
          </div>
          <div class="diagram-controls">
            <button @click=${this.handleZoomOut} ?disabled=${!this.svg} title="Zoom out">−</button>
            <span class="zoom-label">${this.zoomPct}%</span>
            <button @click=${this.handleZoomIn} ?disabled=${!this.svg} title="Zoom in">+</button>
            <button @click=${this.handleFit} ?disabled=${!this.svg} title="Fit to view">Fit</button>
            <span class="sep"></span>
            <button class=${this.showLabels ? 'active' : ''} @click=${this.handleToggleLabels} title="Show / hide port labels (.Name/.Description)">Labels</button>
            <button class=${this.showIds ? 'active' : ''} @click=${this.handleToggleIds} title="Show / hide bare identifier labels">IDs</button>
            <button class=${this.hideJunctions ? 'active' : ''} @click=${this.handleToggleDots} title="Show / hide junction dots">Dots</button>
            <span class="sep"></span>
            <button ?disabled=${!this.svg} @click=${this.handleDownloadSvg} title="Export SVG (vector)">SVG</button>
            <button ?disabled=${!this.svg} @click=${this.handleExportPdf} title="Export PDF">PDF</button>
            <select class="png-scale" ?disabled=${!this.svg} title="Export PNG at selected scale" @change=${this.handlePngScaleChange}>
              <option value="" disabled selected hidden>PNG</option>
              <option value="1">PNG 1x</option>
              <option value="2">PNG 2x</option>
              <option value="3">PNG 3x</option>
              <option value="4">PNG 4x</option>
            </select>
          </div>
        </div>
      </div>
      <div class="main">
        <div class="pane-left" ?hidden=${this.isNarrow && this.mobileView !== 'code'}>
          <ldl-editor
            .value=${this.sourceText}
            .errors=${this.parseErrors}
            .theme=${this.currentTheme.ui}
            @ldl-change=${this.handleSourceChange}
          ></ldl-editor>
          ${this.checks.length ? html`
            <div class="checks-panel">
              ${this.checks.map(c => html`
                <span class="check ${c.ok ? 'ok' : 'fail'}" title=${c.detail ?? (c.ok ? 'passed' : 'failed')}>
                  <span class="check-mark">${c.ok ? '✓' : '✗'}</span>${c.label}${c.detail && !c.ok ? html` <span class="check-detail">(${c.detail})</span>` : ''}
                </span>
              `)}
            </div>
          ` : ''}
        </div>
        <div class="pane-right" ?hidden=${this.isNarrow && this.mobileView !== 'diagram'}>
          <ldl-viewer
            .svg=${this.svg}
            .showLabels=${this.showLabels}
            .showIds=${this.showIds}
            .hideJunctions=${this.hideJunctions}
            .theme=${this.currentTheme.ui}
            @zoom-change=${this.handleZoomChange}
          ></ldl-viewer>
        </div>
      </div>
    `;
  }
}
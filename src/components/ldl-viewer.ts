import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import type { UITheme } from "../theme/themes.js";
import { LIGHT_UI } from "../theme/themes.js";

@customElement("ldl-viewer")
export class LdlViewer extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }
    .viewer-header {
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      background: var(--ldl-toolbar-bg);
      color: var(--ldl-text-dim);
      border-bottom: 1px solid var(--ldl-toolbar-dark);
    }
    .viewer-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--ldl-text-dim);
    }
    .viewer-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .viewer-controls button,
    .viewer-controls .toolbar-btn {
      background: var(--ldl-toolbar-dark);
      color: var(--ldl-toolbar-text);
      border: 1px solid var(--ldl-toolbar-border-alpha20);
      border-radius: 3px;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
    }
    .viewer-controls button:hover,
    .viewer-controls .toolbar-btn:hover {
      background: var(--ldl-toolbar-bg);
      border-color: var(--ldl-toolbar-border-alpha40);
    }
    .viewer-controls button:active,
    .viewer-controls .toolbar-btn:active {
      background: var(--ldl-toolbar-active);
    }
    .viewer-controls .toolbar-btn.active {
      background: var(--ldl-accent);
      border-color: var(--ldl-accent);
      color: white;
    }
    .viewer-controls .toolbar-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .zoom-label {
      font-size: 11px;
      color: var(--ldl-text-muted);
      min-width: 36px;
      text-align: center;
    }
    .separator {
      width: 1px;
      height: 16px;
      background: var(--ldl-toolbar-separator);
    }
    .viewer-wrapper {
      flex: 1;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      background: var(--ldl-surface);
      cursor: grab;
      position: relative;
      user-select: none;
    }
    .viewer-wrapper.dragging {
      cursor: grabbing;
    }
    .viewer-content {
      transform-origin: 0 0;
    }
    /* Render the SVG at the content box's pixel size so transform scaling is exact.
       Without this the SVG's own max-width:100% makes it size to the wrapper, which
       breaks the fit calculation (diagram ends up far smaller than the view). */
    .viewer-content svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .empty-state {
      color: var(--ldl-text-muted);
      font-size: 14px;
      text-align: center;
      margin-top: 40px;
    }
    /* PNG DPI selector styling — it is a <select> but visually matches the toolbar buttons. */
    .viewer-controls .png-scale {
      background: var(--ldl-toolbar-dark);
      color: var(--ldl-toolbar-text);
      border: 1px solid var(--ldl-toolbar-border-alpha20);
      border-radius: 3px;
      padding: 2px 4px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      outline: none;
    }
    .viewer-controls .png-scale:hover {
      background: var(--ldl-toolbar-bg);
      border-color: var(--ldl-toolbar-border-alpha40);
    }
    .viewer-controls .png-scale:focus {
      border-color: var(--ldl-accent);
    }
    /* Tier 4.12 click-to-reveal popup. Surfaces the SVG id of the closest group on click. */
    .reveal-popup {
      position: absolute;
      background: var(--ldl-toolbar-bg);
      color: var(--ldl-toolbar-text);
      border: 1px solid var(--ldl-toolbar-border-alpha40);
      border-radius: 3px;
      padding: 4px 6px;
      font-size: 11px;
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transform: translate(-50%, calc(-100% - 6px));
      pointer-events: auto;
      z-index: 20;
      box-shadow: 0 1px 4px rgba(0,0,0,0.2);
    }
    .reveal-popup .reveal-id {
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .reveal-popup button {
      background: var(--ldl-toolbar-dark);
      color: var(--ldl-toolbar-text);
      border: 1px solid var(--ldl-toolbar-border-alpha20);
      border-radius: 2px;
      padding: 1px 5px;
      font-size: 10px;
      cursor: pointer;
      font-family: inherit;
    }
    .reveal-popup button:hover {
      background: var(--ldl-accent);
      color: white;
    }
    .reveal-popup .reveal-close {
      border: none;
      background: transparent;
      padding: 0 4px;
      font-size: 14px;
      line-height: 1;
    }
  `;

  @property({ type: String }) svg = "";
  @property({ type: Boolean }) showLabels = true;
  @property({ type: Boolean }) showIds = false;
  @property({ type: Boolean }) hideJunctions = false;
  @property({ attribute: false }) theme: UITheme = LIGHT_UI;

  // Tier 4.12 — click-to-reveal popup state. Clicking any element inside the SVG that has an `id`
  // (gate, input, output, wire, junction dot, port group, or net label) surfaces its id in a small
  // popup at the click location. The user can dismiss or copy the id (clipboard write). The popup
  // focuses on the SVG element closest to the click that carries `.id_*`, `.ldl-symbol`,
  // `.ldl-wire`, `.ldl-junction-group`, or `.ldl-net-label`.
  @state() private revealId: { x: number; y: number; id: string } | null = null;

  private scale = 1;
  private panX = 0;
  private panY = 0;
  private isDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;

  private resizeObserver: ResizeObserver | null = null;
  private refitRaf = 0;

  connectedCallback() {
    super.connectedCallback();
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyTheme();
    // Auto-refit when the viewer changes size — window resize, device rotation, or the pane being
    // shown/hidden by the mobile Code/Diagram toggle. Observing the host (which always exists and
    // tracks the pane's size) is robust to the wrapper being re-created between render branches.
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(this.refitRaf);
        this.refitRaf = requestAnimationFrame(() => { if (this.svg) this.handleFit(); });
      });
      this.resizeObserver.observe(this);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    cancelAnimationFrame(this.refitRaf);
  }

  // Fit-to-view only the FIRST diagram (and on an explicit request — Fit button, example switch).
  // For subsequent SVG updates (live edits) the current zoom & pan are KEPT, so the user watches the
  // diagram update in place instead of it snapping back to a fit on every keystroke.
  private fitOnNextSvg = true;
  requestFit() { this.fitOnNextSvg = true; }

  updated(changed: Map<string, any>) {
    if (changed.has('theme')) {
      this.applyTheme();
    }
    if (changed.has('svg') && this.svg) {
      requestAnimationFrame(() => {
        this.setContentSize();               // pin the (possibly resized) diagram box
        if (this.fitOnNextSvg) {
          this.fitOnNextSvg = false;
          this.handleFit();                  // first diagram / explicit fit
        } else {
          this.updateTransform();            // live edit: keep the user's zoom & pan
        }
      });
    }
  }

  private getSvgSize(): { w: number; h: number } | null {
    const svgEl = this.shadowRoot?.querySelector('.viewer-content svg');
    const vb = svgEl?.getAttribute('viewBox')?.split(/\s+/).map(Number);
    if (!vb || vb.length < 4 || !vb[2] || !vb[3]) return null;
    return { w: vb[2], h: vb[3] };
  }

  private setContentSize() {
    const content = this.shadowRoot?.querySelector('.viewer-content') as HTMLElement;
    const s = this.getSvgSize();
    if (content && s) {
      content.style.width = `${s.w}px`;
      content.style.height = `${s.h}px`;
    }
  }

  private applyTheme() {
    const t = this.theme;
    this.style.setProperty('--ldl-toolbar-bg', t.toolbarBg);
    this.style.setProperty('--ldl-toolbar-dark', t.toolbarDark);
    this.style.setProperty('--ldl-toolbar-active', t.toolbarActive);
    this.style.setProperty('--ldl-text-dim', t.textDim);
    this.style.setProperty('--ldl-text-muted', t.textMuted);
    this.style.setProperty('--ldl-surface', t.surface);
    this.style.setProperty('--ldl-accent', t.accent);
    this.style.setProperty('--ldl-toolbar-text', t.toolbarText);
    this.style.setProperty('--ldl-toolbar-border-alpha20', t.toolbarBorderAlpha20);
    this.style.setProperty('--ldl-toolbar-border-alpha40', t.toolbarBorderAlpha40);
    this.style.setProperty('--ldl-toolbar-separator', t.toolbarSeparator);
  }

  // Public zoom/fit controls — driven from the app toolbar (the controls live there so the viewer
  // pane is all diagram, no separate header row).
  zoomIn() {
    this.scale = Math.min(5, this.scale * 1.25);
    this.updateTransform();
  }

  zoomOut() {
    this.scale = Math.max(0.1, this.scale / 1.25);
    this.updateTransform();
  }

  fit() { this.handleFit(); }

  private handleFit() {
    const wrapper = this.shadowRoot?.querySelector(
      ".viewer-wrapper",
    ) as HTMLElement;
    const size = this.getSvgSize();
    if (!wrapper || !size) return;

    // Pin the content box to the diagram's pixel size so the transform scales it exactly.
    this.setContentSize();

    const wrapperRect = wrapper.getBoundingClientRect();
    if (wrapperRect.width <= 0 || wrapperRect.height <= 0) return;

    const margin = 24;
    const scaleX = (wrapperRect.width - margin) / size.w;
    const scaleY = (wrapperRect.height - margin) / size.h;
    // Fit both extents as fully as possible (cap only to avoid absurd upscaling).
    this.scale = Math.max(0.05, Math.min(scaleX, scaleY, 4));

    const contentW = size.w * this.scale;
    const contentH = size.h * this.scale;
    this.panX = Math.max(0, (wrapperRect.width - contentW) / 2);
    this.panY = Math.max(0, (wrapperRect.height - contentH) / 2);

    this.updateTransform();
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    this.scale = Math.max(0.1, Math.min(5, this.scale * delta));
    this.updateTransform();
  }

  private handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    this.isDragging = true;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    const wrapper = this.shadowRoot?.querySelector(".viewer-wrapper");
    if (wrapper) wrapper.classList.add("dragging");
  }

  private handleMouseMove(e: MouseEvent) {
    if (!this.isDragging) return;
    const dx = e.clientX - this.lastMouseX;
    const dy = e.clientY - this.lastMouseY;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    this.panX += dx;
    this.panY += dy;
    this.updateTransform();
  }

  private handleMouseUp() {
    this.isDragging = false;
    const wrapper = this.shadowRoot?.querySelector(".viewer-wrapper");
    if (wrapper) wrapper.classList.remove("dragging");
  }

  private updateTransform() {
    const content = this.shadowRoot?.querySelector(
      ".viewer-content",
    ) as HTMLElement;
    if (content) {
      content.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
    }
    // The zoom % is displayed by the app toolbar; publish the current scale so it can update.
    this.emitEvent('zoom-change', { pct: Math.round(this.scale * 100) });
  }

  private emitEvent(name: string, detail?: any) {
    this.dispatchEvent(
      new CustomEvent(name, { bubbles: true, composed: true, detail }),
    );
  }

  // Tier 4.12 — click-to-reveal. Walk up the DOM from the click target to find the first element
  // with an `id` in the SVG. Marks the popup; a second click anywhere else dismisses it.
  private handleSvgClick(e: MouseEvent) {
    if (this.isDragging) return;
    const wrapper = this.shadowRoot?.querySelector('.viewer-wrapper') as HTMLElement;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const target = e.target as Element;
    let el: Element | null = target;
    while (el && el !== wrapper) {
      const id = el.getAttribute?.('id');
      // Skip generated wire/pin ids by default — but reveal gate/object ids. A gate, FB, SR,
      // input, output, junction group, or net label all carry a meaningful id (svgObjectId/
      // dot_<n>/netlabel_<n>). Wires reveal too if clicked directly.
      if (id) {
        this.revealId = { x: cx, y: cy, id };
        return;
      }
      el = el.parentElement;
    }
    this.revealId = null;
  }

  private dismissReveal() {
    this.revealId = null;
  }

  private async copyRevealId() {
    if (!this.revealId) return;
    try { await navigator.clipboard.writeText(this.revealId.id); } catch { /* ignore */ }
    this.revealId = null;
  }


  render() {
    if (this.svg) {
      return html`
        <div
          class="viewer-wrapper"
          @wheel=${this.handleWheel}
          @mousedown=${this.handleMouseDown}
          @mousemove=${this.handleMouseMove}
          @mouseup=${this.handleMouseUp}
          @mouseleave=${this.handleMouseUp}
          @click=${this.handleSvgClick}
        >
          <div class="viewer-content">${unsafeSVG(this.svg)}</div>
          ${this.revealId ? html`
            <div class="reveal-popup" style="left:${this.revealId.x}px; top:${this.revealId.y}px" @click=${(ev: Event) => ev.stopPropagation()}>
              <span class="reveal-id">${this.revealId.id}</span>
              <button class="reveal-copy" @click=${this.copyRevealId} title="Copy to clipboard">Copy</button>
              <button class="reveal-close" @click=${this.dismissReveal} title="Dismiss">×</button>
            </div>
          ` : ''}
        </div>
      `;
    }

    return html`
      <div class="viewer-wrapper">
        <div class="empty-state">
          Enter LDL source on the left to see the diagram
        </div>
      </div>
    `;
  }
}
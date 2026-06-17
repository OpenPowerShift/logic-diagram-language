import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
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
    .empty-state {
      color: var(--ldl-text-muted);
      font-size: 14px;
      text-align: center;
      margin-top: 40px;
    }
  `;

  @property({ type: String }) svg = "";
  @property({ type: Boolean }) showLabels = true;
  @property({ type: Boolean }) showIds = false;
  @property({ attribute: false }) theme: UITheme = LIGHT_UI;

  private scale = 1;
  private panX = 0;
  private panY = 0;
  private isDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;

  connectedCallback() {
    super.connectedCallback();
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyTheme();
  }

  updated(changed: Map<string, any>) {
    if (changed.has('theme')) {
      this.applyTheme();
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

  private handleZoomIn() {
    this.scale = Math.min(5, this.scale * 1.25);
    this.updateTransform();
  }

  private handleZoomOut() {
    this.scale = Math.max(0.1, this.scale / 1.25);
    this.updateTransform();
  }

  private handleFit() {
    const content = this.shadowRoot?.querySelector(
      ".viewer-content",
    ) as HTMLElement;
    const wrapper = this.shadowRoot?.querySelector(
      ".viewer-wrapper",
    ) as HTMLElement;
    if (!content || !wrapper) return;

    const svgEl = content.querySelector("svg");
    if (!svgEl) return;

    const vb = svgEl.getAttribute("viewBox")?.split(" ").map(Number);
    if (!vb || vb.length < 4) return;

    const svgW = vb[2];
    const svgH = vb[3];
    const wrapperRect = wrapper.getBoundingClientRect();

    if (wrapperRect.width <= 0 || wrapperRect.height <= 0) return;

    const scaleX = (wrapperRect.width - 20) / svgW;
    const scaleY = (wrapperRect.height - 20) / svgH;
    this.scale = Math.min(scaleX, scaleY, 3);

    const contentW = svgW * this.scale;
    const contentH = svgH * this.scale;
    this.panX = (wrapperRect.width - contentW) / 2;
    this.panY = (wrapperRect.height - contentH) / 2;

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
    const label = this.shadowRoot?.querySelector(".zoom-label") as HTMLElement;
    if (label) {
      label.textContent = `${Math.round(this.scale * 100)}%`;
    }
  }

  private emitEvent(name: string) {
    this.dispatchEvent(
      new CustomEvent(name, { bubbles: true, composed: true }),
    );
  }

  render() {
    if (this.svg) {
      return html`
        <div class="viewer-header">
          <span class="viewer-title">Diagram</span>
          <div class="viewer-controls">
            <button @click=${this.handleZoomOut} title="Zoom out">-</button>
            <span class="zoom-label">100%</span>
            <button @click=${this.handleZoomIn} title="Zoom in">+</button>
            <button @click=${this.handleFit} title="Fit to view">Fit</button>
            <div class="separator"></div>
            <button
              class="toolbar-btn ${this.showLabels ? "active" : ""}"
              @click=${() => this.emitEvent("toggle-labels")}
            >
              Labels
            </button>
            <button
              class="toolbar-btn ${this.showIds ? "active" : ""}"
              @click=${() => this.emitEvent("toggle-ids")}
            >
              IDs
            </button>
            <div class="separator"></div>
            <button
              class="toolbar-btn"
              @click=${() => this.emitEvent("download-svg")}
            >
              SVG
            </button>
            <button
              class="toolbar-btn"
              @click=${() => this.emitEvent("export-pdf")}
            >
              PDF
            </button>
          </div>
        </div>
        <div
          class="viewer-wrapper"
          @wheel=${this.handleWheel}
          @mousedown=${this.handleMouseDown}
          @mousemove=${this.handleMouseMove}
          @mouseup=${this.handleMouseUp}
          @mouseleave=${this.handleMouseUp}
        >
          <div class="viewer-content">${unsafeSVG(this.svg)}</div>
        </div>
      `;
    }

    return html`
      <div class="viewer-header">
        <span class="viewer-title">Diagram</span>
        <div class="viewer-controls">
          <button
            class="toolbar-btn"
            @click=${() => this.emitEvent("toggle-labels")}
          >
            Labels
          </button>
          <button
            class="toolbar-btn"
            @click=${() => this.emitEvent("toggle-ids")}
          >
            IDs
          </button>
          <button class="toolbar-btn" disabled>SVG</button>
          <button class="toolbar-btn" disabled>PDF</button>
        </div>
      </div>
      <div class="viewer-wrapper">
        <div class="empty-state">
          Enter LDL source on the left to see the diagram
        </div>
      </div>
    `;
  }
}
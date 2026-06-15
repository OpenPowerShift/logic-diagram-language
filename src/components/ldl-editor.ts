import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, foldGutter, indentOnInput, bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { ldlLanguage } from '../highlight/ldl-language.js';

@customElement('ldl-editor')
export class LdlEditor extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }
    .editor-container {
      flex: 1;
      overflow: hidden;
    }
    .error-panel {
      max-height: 80px;
      overflow-y: auto;
      padding: 6px 10px;
      background: #fdecea;
      border-top: 1px solid #e57373;
      font-size: 11px;
      font-family: monospace;
      color: #c62828;
    }
    .cm-editor {
      height: 100%;
    }
    .cm-editor .cm-scroller {
      font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
    }
  `;

  @property({ type: String }) value = '';
  @property({ type: Array }) errors: { message: string; line: number; column: number }[] = [];

  private editorView: EditorView | null = null;
  private ignoreNextChange = false;

  firstUpdated() {
    this.initEditor();
  }

  private initEditor() {
    const container = this.shadowRoot!.querySelector('.editor-container');
    if (!container) return;

    this.editorView = new EditorView({
      state: EditorState.create({
        doc: this.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          ldlLanguage(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !this.ignoreNextChange) {
              this.value = update.state.doc.toString();
              this.dispatchEvent(new CustomEvent('ldl-change', {
                detail: { value: this.value },
                bubbles: true,
                composed: true,
              }));
            }
          }),
          EditorView.theme({
            '&': {
              height: '100%',
              fontSize: '13px',
              background: '#ffffff',
              color: '#2c3e50',
            },
            '.cm-content': {
              fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
              caretColor: '#2c3e50',
            },
            '.cm-gutters': {
              background: '#f5f6fa',
              color: '#90a4ae',
              border: 'none',
            },
            '.cm-activeLineGutter': {
              background: '#e8eaf0',
            },
            '.cm-activeLine': {
              background: '#f0f2f8',
            },
            '&.cm-focused .cm-cursor': {
              borderLeftColor: '#2c3e50',
            },
            '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
              backgroundColor: 'rgba(52, 152, 219, 0.25) !important',
            },
            '.cm-comment': { color: '#6a9955' },
            '.cm-keyword': { color: '#9c27b0' },
            '.cm-typeName': { color: '#1565c0' },
            '.cm-variableName': { color: '#2c3e50' },
            '.cm-string': { color: '#e65100' },
            '.cm-number': { color: '#00695c' },
            '.cm-punctuation': { color: '#78909c' },
          }),
        ],
      }),
      parent: container,
    });
  }

  updated(changed: Map<string, any>) {
    if (changed.has('value') && this.editorView) {
      const currentDoc = this.editorView.state.doc.toString();
      if (currentDoc !== this.value) {
        this.ignoreNextChange = true;
        this.editorView.dispatch({
          changes: {
            from: 0,
            to: this.editorView.state.doc.length,
            insert: this.value,
          },
        });
        this.ignoreNextChange = false;
      }
    }
  }

  render() {
    const errorHtml = this.errors.length > 0
      ? html`<div class="error-panel">
          ${this.errors.map(e => html`<div>Line ${e.line}, Col ${e.column}: ${e.message}</div>`)}
        </div>`
      : nothing;

    return html`
      <div class="editor-container"></div>
      ${errorHtml}
    `;
  }
}
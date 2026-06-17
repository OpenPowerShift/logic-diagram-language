import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, foldGutter, indentOnInput, bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { ldlLanguage } from '../highlight/ldl-language.js';
import type { UITheme } from '../theme/themes.js';
import { LIGHT_UI } from '../theme/themes.js';

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
      background: var(--ldl-error-bg);
      border-top: 1px solid var(--ldl-error-border);
      font-size: 11px;
      font-family: monospace;
      color: var(--ldl-error-text);
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
  @property({ attribute: false }) theme: UITheme = LIGHT_UI;

  private editorView: EditorView | null = null;
  private ignoreNextChange = false;

  firstUpdated() {
    this.initEditor();
  }

  private applyThemeToStyles() {
    const t = this.theme;
    this.style.setProperty('--ldl-error-bg', t.errorBg);
    this.style.setProperty('--ldl-error-border', t.errorBorder);
    this.style.setProperty('--ldl-error-text', t.errorText);
  }

  updated(changed: Map<string, any>) {
    this.applyThemeToStyles();

    if (changed.has('theme') && this.editorView) {
      this.recreateEditor();
      return;
    }

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

  private getEditorTheme() {
    const t = this.theme;
    return EditorView.theme({
      '&': {
        height: '100%',
        fontSize: '13px',
        background: t.editorBg,
        color: t.syntaxVariable,
      },
      '.cm-content': {
        fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
        caretColor: t.editorCursor,
      },
      '.cm-gutters': {
        background: t.editorGutter,
        color: t.editorGutterText,
        border: 'none',
      },
      '.cm-activeLineGutter': {
        background: t.editorActiveGutter,
      },
      '.cm-activeLine': {
        background: t.editorActiveLine,
      },
      '&.cm-focused .cm-cursor': {
        borderLeftColor: t.editorCursor,
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: `${t.editorSelection} !important`,
      },
      '.cm-comment': { color: t.syntaxComment },
      '.cm-keyword': { color: t.syntaxKeyword },
      '.cm-typeName': { color: t.syntaxType },
      '.cm-variableName': { color: t.syntaxVariable },
      '.cm-string': { color: t.syntaxString },
      '.cm-number': { color: t.syntaxNumber },
      '.cm-punctuation': { color: t.syntaxPunct },
    });
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
          this.getEditorTheme(),
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
        ],
      }),
      parent: container,
    });
  }

  private recreateEditor() {
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }
    const container = this.shadowRoot!.querySelector('.editor-container');
    if (!container) return;
    container.innerHTML = '';

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
          this.getEditorTheme(),
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
        ],
      }),
      parent: container,
    });
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
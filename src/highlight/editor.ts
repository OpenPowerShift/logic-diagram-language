import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, foldGutter, indentOnInput, bracketMatching, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { ldlLanguage } from './ldl-language.js';

const ldlHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: '#4ec9b0', fontWeight: 'bold' },
]);

export function createEditorView(
  initialContent: string,
  onChange: (value: string) => void,
): EditorView {
  const state = EditorState.create({
    doc: initialContent,
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
      syntaxHighlighting(ldlHighlightStyle),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChange(update.state.doc.toString());
        }
      }),
      EditorView.theme({
        '&': {
          height: '100%',
          fontSize: '13px',
          background: 'var(--ldl-surface, #0f1729)',
          color: 'var(--ldl-text, #e0e0e0)',
        },
        '.cm-content': {
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          caretColor: 'var(--ldl-accent, #e94560)',
        },
        '.cm-gutters': {
          background: 'var(--ldl-bg, #1a1a2e)',
          color: 'var(--ldl-text-dim, #888)',
          border: 'none',
        },
        '.cm-activeLineGutter': {
          background: 'rgba(255,255,255,0.05)',
        },
        '.cm-activeLine': {
          background: 'rgba(255,255,255,0.03)',
        },
        '&.cm-focused .cm-cursor': {
          borderLeftColor: 'var(--ldl-accent, #e94560)',
        },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
          backgroundColor: 'rgba(233, 69, 96, 0.3) !important',
        },
      }),
    ],
  });

  return new EditorView({
    state,
    parent: document.createElement('div'),
  });
}
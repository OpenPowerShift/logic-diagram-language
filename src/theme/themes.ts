export interface DiagramTheme {
  background: string;
  stroke: string;
  fill: string;
  wire: string;
  wireHover: string;
  portFill: string;
  nameFill: string;
  nameOutFill: string;
  descFill: string;
  idFill: string;
  junctionFill: string;
}

export interface UITheme {
  bg: string;
  surface: string;
  border: string;
  text: string;
  textDim: string;
  textMuted: string;
  toolbarBg: string;
  toolbarDark: string;
  toolbarActive: string;
  accent: string;
  errorBg: string;
  errorBorder: string;
  errorText: string;
  editorBg: string;
  editorGutter: string;
  editorGutterText: string;
  editorActiveLine: string;
  editorActiveGutter: string;
  editorCursor: string;
  editorSelection: string;
  syntaxComment: string;
  syntaxKeyword: string;
  syntaxType: string;
  syntaxVariable: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxPunct: string;
  toolbarText: string;
  toolbarBorderAlpha20: string;
  toolbarBorderAlpha40: string;
  toolbarSeparator: string;
}

export interface AppTheme {
  name: string;
  ui: UITheme;
  diagram: DiagramTheme;
  print: DiagramTheme;
}

export const LIGHT_DIAGRAM: DiagramTheme = {
  background: '#ffffff',
  stroke: '#2c3e50',
  fill: '#ffffff',
  wire: '#34495e',
  wireHover: '#1b5e20',
  portFill: '#2c3e50',
  nameFill: '#1a237e',
  nameOutFill: '#1a237e',
  descFill: '#607d8b',
  idFill: '#90a4ae',
  junctionFill: '#34495e',
};

export const DARK_DIAGRAM: DiagramTheme = {
  background: '#1a1b2e',
  stroke: '#c8cdd5',
  fill: '#2a2b3d',
  wire: '#9aa5b4',
  wireHover: '#4caf50',
  portFill: '#c8cdd5',
  nameFill: '#82b1ff',
  nameOutFill: '#82b1ff',
  descFill: '#90a4ae',
  idFill: '#607080',
  junctionFill: '#9aa5b4',
};

export const LIGHT_UI: UITheme = {
  bg: '#f5f6fa',
  surface: '#e8eaf0',
  border: '#dce1e8',
  text: '#2c3e50',
  textDim: '#78909c',
  textMuted: '#90a4ae',
  toolbarBg: '#2c3e50',
  toolbarDark: '#1a252f',
  toolbarActive: '#0f3460',
  accent: '#3498db',
  errorBg: '#fdecea',
  errorBorder: '#e57373',
  errorText: '#c62828',
  editorBg: '#ffffff',
  editorGutter: '#f5f6fa',
  editorGutterText: '#90a4ae',
  editorActiveLine: '#f0f2f8',
  editorActiveGutter: '#e8eaf0',
  editorCursor: '#2c3e50',
  editorSelection: 'rgba(52, 152, 219, 0.25)',
  syntaxComment: '#6a9955',
  syntaxKeyword: '#9c27b0',
  syntaxType: '#1565c0',
  syntaxVariable: '#2c3e50',
  syntaxString: '#e65100',
  syntaxNumber: '#00695c',
  syntaxPunct: '#78909c',
  toolbarText: '#e0e0e0',
  toolbarBorderAlpha20: 'rgba(255,255,255,0.2)',
  toolbarBorderAlpha40: 'rgba(255,255,255,0.4)',
  toolbarSeparator: 'rgba(255,255,255,0.25)',
};

export const DARK_UI: UITheme = {
  bg: '#12131e',
  surface: '#1a1b2e',
  border: '#2e3045',
  text: '#e2e8f0',
  textDim: '#9aa5b4',
  textMuted: '#607080',
  toolbarBg: '#1e1f32',
  toolbarDark: '#141525',
  toolbarActive: '#283593',
  accent: '#42a5f5',
  errorBg: '#2d1215',
  errorBorder: '#c62828',
  errorText: '#ef9a9a',
  editorBg: '#1a1b2e',
  editorGutter: '#12131e',
  editorGutterText: '#607080',
  editorActiveLine: '#252640',
  editorActiveGutter: '#2a2b3d',
  editorCursor: '#e2e8f0',
  editorSelection: 'rgba(66, 165, 245, 0.25)',
  syntaxComment: '#6a9955',
  syntaxKeyword: '#ce93d8',
  syntaxType: '#64b5f6',
  syntaxVariable: '#e2e8f0',
  syntaxString: '#ffab91',
  syntaxNumber: '#4db6ac',
  syntaxPunct: '#9aa5b4',
  toolbarText: '#e0e0e0',
  toolbarBorderAlpha20: 'rgba(255,255,255,0.2)',
  toolbarBorderAlpha40: 'rgba(255,255,255,0.4)',
  toolbarSeparator: 'rgba(255,255,255,0.25)',
};

export const LIGHT_THEME: AppTheme = {
  name: 'light',
  ui: LIGHT_UI,
  diagram: LIGHT_DIAGRAM,
  print: LIGHT_DIAGRAM,
};

export const DARK_THEME: AppTheme = {
  name: 'dark',
  ui: DARK_UI,
  diagram: DARK_DIAGRAM,
  print: LIGHT_DIAGRAM,
};
import { LIGHT_THEME, DARK_THEME } from './themes.js';
import type { AppTheme } from './themes.js';

type ThemeListener = (theme: AppTheme) => void;

const listeners = new Set<ThemeListener>();
let currentTheme: AppTheme = LIGHT_THEME;

if (typeof window !== 'undefined') {
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  currentTheme = mql.matches ? DARK_THEME : LIGHT_THEME;
  mql.addEventListener('change', (e) => {
    currentTheme = e.matches ? DARK_THEME : LIGHT_THEME;
    for (const listener of listeners) {
      listener(currentTheme);
    }
  });
}

export function getCurrentTheme(): AppTheme {
  return currentTheme;
}

export function onThemeChange(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
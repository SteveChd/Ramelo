// Light or dark theme, remembered between sessions.

const KEY = 'ramelo.theme';
const listeners = new Set();

export function currentTheme() {
  return document.documentElement.dataset.theme;
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) listener(theme);
}

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* preference not remembered */ }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  apply(saved ?? (prefersDark ? 'dark' : 'light'));
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(KEY, next); } catch { /* preference not remembered */ }
  apply(next);
}

export function onThemeChange(listener) {
  listeners.add(listener);
}

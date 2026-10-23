// Translation of the interface. English is the default language; the choice is remembered.
//
//   t('status.repos', { n: 3 })  →  « 3 repositories »
//   tn('home.count', 2)          →  key « home.count.other » with { n: 2 }

import en from './en.js';
import fr from './fr.js';

const DICTIONARIES = { en, fr };
const LOCALES = { en: 'en-GB', fr: 'fr-FR' };
const KEY = 'gitcontroller.language';

export const LANGUAGES = Object.keys(DICTIONARIES);

const listeners = new Set();
let current = 'en';

try {
  const saved = localStorage.getItem(KEY);
  if (saved in DICTIONARIES) current = saved;
} catch { /* preference not remembered: English */ }
document.documentElement.lang = current;

export function language() {
  return current;
}

/** Language code for date formats (Intl). */
export function locale() {
  return LOCALES[current];
}

export function setLanguage(lang) {
  if (!(lang in DICTIONARIES) || lang === current) return;
  current = lang;
  document.documentElement.lang = lang;
  try { localStorage.setItem(KEY, lang); } catch { /* preference not remembered */ }
  for (const listener of listeners) listener(lang);
}

export function onLanguageChange(listener) {
  listeners.add(listener);
}

/** Translated text; `{name}` is replaced by `params.name`. An unknown key is shown as is. */
export function t(key, params = {}) {
  const text = DICTIONARIES[current][key] ?? DICTIONARIES.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => (name in params ? String(params[name]) : `{${name}}`));
}

/** Singular / plural variant: keys `key.one` and `key.other`. */
export function tn(key, n, params = {}) {
  // In French, the singular covers any quantity below 2 (0, 1).
  const one = current === 'fr' ? Math.abs(n) < 2 : n === 1;
  return t(`${key}.${one ? 'one' : 'other'}`, { n, ...params });
}

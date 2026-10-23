// Commands of the interface, shared by the menus and the keyboard: label, shortcut, availability and
// what they do.

import { toggleTheme } from '../components/theme.js';
import { t } from '../i18n/i18n.js';
import { store } from '../state/store.js';

const hasActive = () => store.activeRepo !== null;
const hasRepos = () => store.repositories.length > 0;

/** Moves to the next (`step` 1) or previous (-1) tab; the overview is the first tab. */
function cycleTab(step) {
  const tabs = [null, ...store.repositories.map((r) => r.path)];
  const index = tabs.indexOf(store.active);
  store.select(tabs[(index + step + tabs.length) % tabs.length]);
}

/** Tab number `n` (1: the overview, 2: the first repository…). */
function goToTab(n) {
  if (n === 1) return store.select(null);
  const repo = store.repositories[n - 2];
  if (repo) store.select(repo.path);
}

const ACTIONS = {
  'repo.add': { key: 'Ctrl+O', run: () => store.add() },
  'repo.refresh': { key: 'F5', enabled: hasRepos, run: () => store.refresh(store.activeRepo?.path ?? null) },
  'repo.refreshAll': { key: 'Ctrl+F5', enabled: hasRepos, run: () => store.refresh(null) },
  'repo.openFolder': { key: 'Ctrl+Shift+E', enabled: hasActive, run: () => store.openFolder(store.active) },
  'repo.remove': { key: 'Ctrl+W', enabled: hasActive, run: () => store.remove(store.active) },
  'view.home': { key: 'Ctrl+1', run: () => goToTab(1) },
  'view.nextTab': { key: 'Ctrl+Tab', enabled: hasRepos, run: () => cycleTab(1) },
  'view.prevTab': { key: 'Ctrl+Shift+Tab', enabled: hasRepos, run: () => cycleTab(-1) },
  'view.theme': { run: () => toggleTheme() },
};

// Ctrl+2 … Ctrl+9: the repository tabs, as in a browser.
for (let n = 2; n <= 9; n += 1) {
  ACTIONS[`view.tab${n}`] = { key: `Ctrl+${n}`, hidden: true, run: () => goToTab(n) };
}

export function label(name) {
  return t(`action.${name}`);
}

export function shortcut(name) {
  return ACTIONS[name]?.key ?? null;
}

export function isEnabled(name) {
  const action = ACTIONS[name];
  return Boolean(action) && (action.enabled?.() ?? true);
}

export function run(name) {
  if (isEnabled(name)) ACTIONS[name].run();
}

/** Name of the action bound to a shortcut such as « Ctrl+Shift+Tab ». */
export function actionForShortcut(combo) {
  return Object.keys(ACTIONS).find((name) => ACTIONS[name].key === combo) ?? null;
}

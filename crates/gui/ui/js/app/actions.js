// Commands of the interface, shared by the menus and the keyboard: label, shortcut, availability and
// what they do.

import { openAccountsDialog } from '../components/accounts-dialog.js';
import { openAboutDialog } from '../components/about-dialog.js';
import { openSettingsDialog } from '../components/settings-dialog.js';
import { openNewPullDialog } from '../components/new-pull-dialog.js';
import { openTabList } from '../components/tabbar.js';
import { toggleTheme } from '../components/theme.js';
import { t } from '../i18n/i18n.js';
import { layout } from '../state/layout.js';
import { pulls } from '../state/pulls.js';
import { repoStore } from '../state/repo-store.js';
import { search } from '../state/search.js';
import { store } from '../state/store.js';

const hasActive = () => store.activeRepo !== null;
const hasRepos = () => store.repositories.length > 0;
const hasTabs = () => store.tabs.length > 0;
const selectedCommit = () => hasActive() && repoStore.state.selection !== 'wip' && !repoStore.state.running;

/** Moves to the next (`step` 1) or previous (-1) tab; the overview is the first tab. */
function cycleTab(step) {
  const tabs = [null, ...store.tabs.map((r) => r.path)];
  const index = tabs.indexOf(store.active);
  store.select(tabs[(index + step + tabs.length) % tabs.length]);
}

/** Tab number `n` (1: the overview, 2: the first repository…). */
function goToTab(n) {
  if (n === 1) return store.select(null);
  const repo = store.tabs[n - 2];
  if (repo) store.select(repo.path);
}

const ACTIONS = {
  'app.accounts': { key: 'Ctrl+,', run: () => openAccountsDialog() },
  'app.settings': { run: () => openSettingsDialog() },
  'app.about': { run: () => openAboutDialog() },
  'view.onlyCurrentBranch': { key: 'Ctrl+Shift+B', enabled: hasActive, run: () => repoStore.soloCurrent() },
  'view.allBranches': { enabled: () => hasActive() && Boolean(repoStore.state.filter), run: () => repoStore.setFilter(null) },
  'repo.add': { key: 'Ctrl+O', run: () => store.add() },
  'repo.clone': { key: 'Ctrl+Shift+O', run: () => store.clone() },
  'repo.find': { key: 'Ctrl+Shift+N', run: () => store.find() },
  'repo.refresh': { key: 'F5', enabled: hasRepos, run: () => store.refresh(store.activeRepo?.path ?? null) },
  'repo.refreshAll': { key: 'Ctrl+F5', enabled: hasRepos, run: () => store.refresh(null) },
  'repo.openFolder': { key: 'Ctrl+Shift+E', enabled: hasActive, run: () => store.openFolder(store.active) },
  'repo.openVsCode': { key: 'Ctrl+Alt+O', enabled: hasActive, run: () => store.openInVsCode(store.active) },
  'repo.closeTab': { key: 'Ctrl+W', enabled: hasActive, run: () => store.close(store.active) },
  'repo.closeAllTabs': { key: 'Ctrl+Shift+W', enabled: () => store.tabs.some((r) => !r.pinned), run: () => store.closeAll() },
  'repo.pinTab': { enabled: hasActive, run: () => store.setPinned(store.active, !store.activeRepo?.pinned) },
  'repo.removeAll': { enabled: hasRepos, run: () => store.removeMany() },
  'repo.remove': { enabled: hasActive, run: () => store.remove(store.active) },
  'view.home': { key: 'Ctrl+1', run: () => goToTab(1) },
  'view.nextTab': { key: 'Ctrl+Tab', enabled: hasTabs, run: () => cycleTab(1) },
  'view.prevTab': { key: 'Ctrl+Shift+Tab', enabled: hasTabs, run: () => cycleTab(-1) },
  'view.tabList': { key: 'Ctrl+Shift+A', enabled: hasTabs, run: () => openTabList() },
  'view.theme': { run: () => toggleTheme() },
  'commit.moveUp': { key: 'Alt+ArrowUp', enabled: selectedCommit, run: () => repoStore.moveCommit(repoStore.state.selection, 'up') },
  'commit.moveDown': { key: 'Alt+ArrowDown', enabled: selectedCommit, run: () => repoStore.moveCommit(repoStore.state.selection, 'down') },
  'view.toggleLeft': { key: 'Alt+1', enabled: hasActive, run: () => layout.toggle('leftCollapsed') },
  'view.toggleRight': { key: 'Alt+2', enabled: hasActive, run: () => layout.toggle('rightCollapsed') },
  'view.toggleDiff': { key: 'Alt+3', enabled: () => Boolean(repoStore.state.diff), run: () => layout.toggle('diffCollapsed') },
  'view.maximizeDiff': { key: 'Alt+4', enabled: () => Boolean(repoStore.state.diff), run: () => layout.set({ diffMaximized: !layout.state.diffMaximized, diffCollapsed: false }) },
  'view.splitDiff': { key: 'Alt+5', enabled: () => Boolean(repoStore.state.diff), run: () => layout.set({ diffSplit: !layout.state.diffSplit }) },
  'repo.fetch': { key: 'Ctrl+Shift+F', enabled: () => Boolean(store.activeRepo?.summary?.remotes.length), run: () => repoStore.fetch() },
  'repo.pull': { key: 'Ctrl+Shift+L', enabled: () => Boolean(store.activeRepo?.summary?.upstream), run: () => repoStore.pull() },
  'repo.push': { key: 'Ctrl+Shift+P', enabled: () => Boolean(store.activeRepo?.summary?.head.branch), run: () => repoStore.push() },
  'repo.newPull': { enabled: () => Boolean(store.active && pulls.of(store.active)?.hosting), run: () => openNewPullDialog(store.active) },
  'repo.newBranch': { key: 'Ctrl+B', enabled: hasActive, run: () => repoStore.createBranch() },
  'repo.stageAll': { key: 'Ctrl+Shift+S', enabled: hasActive, run: () => repoStore.stageAll() },
  // In a repository: its commits; on the overview: the repositories.
  'repo.search': {
    key: 'Ctrl+F',
    enabled: () => !store.activeRepo?.error,
    run: () => (store.activeRepo ? search.open() : document.querySelector('.home-head input[type="search"]')?.select()),
  },
  'repo.searchNext': { key: 'F3', hidden: true, enabled: () => search.active, run: () => search.next() },
  'repo.searchPrev': { key: 'Shift+F3', hidden: true, enabled: () => search.active, run: () => search.prev() },
  'repo.closeDiff': { key: 'Escape', hidden: true, enabled: () => Boolean(repoStore.state.diff), run: () => repoStore.closeDiff() },
};

// Ctrl+2 … Ctrl+9: the repository tabs, as in a browser.
for (let n = 2; n <= 9; n += 1) {
  ACTIONS[`view.tab${n}`] = { key: `Ctrl+${n}`, hidden: true, run: () => goToTab(n) };
}

export function label(name) {
  return t(`action.${name}`);
}

export function shortcut(name) {
  return ACTIONS[name]?.key?.replace('ArrowUp', '↑').replace('ArrowDown', '↓') ?? null;
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

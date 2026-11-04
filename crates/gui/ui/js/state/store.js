// State of the interface: the last snapshot received from the backend (the repositories of the
// workspace and their state) and what belongs to the display only (busy indicator, overview filter).
//
// Every change goes through a backend command, which returns a new snapshot.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { openCloneDialog } from '../components/clone-dialog.js';
import { openRepoFinder } from '../components/repo-finder.js';
import { confirm, prompt } from '../components/dialog.js';
import { t, tn } from '../i18n/i18n.js';

const listeners = new Set();

/** Repositories read at the same time at startup. */
const PARALLEL_READS = 4;

const state = {
  repositories: [],
  /** Path of the repository shown; null for the overview. */
  active: null,
  /** Sections of the overview, in order ({ name, collapsed }), and whether the others are folded. */
  sections: [],
  othersCollapsed: false,
  ui: {
    /** Number of backend calls in progress. */
    busy: 0,
    /** Last time every repository was read again. */
    refreshedAt: null,
    /** Overview: text typed in the search field and quick filter (all | changes | sync | attention). */
    search: '',
    filter: 'all',
  },
};

/**
 * `topic` tells what changed: 'workspace' (new snapshot), 'busy', 'ui' (overview filter), or
 * 'notice' / 'error' with the translated message in `detail`.
 */
function emit(topic, detail) {
  for (const listener of listeners) listener(topic, state, detail);
}

function apply(snapshot) {
  state.repositories = snapshot.repositories;
  state.active = snapshot.active ?? null;
  state.sections = snapshot.sections ?? [];
  state.othersCollapsed = Boolean(snapshot.othersCollapsed);
  emit('workspace');
}

/** Runs a backend call: shows the busy indicator, and explains a failure to the user. */
async function run(call) {
  state.ui.busy += 1;
  emit('busy');
  try {
    return await call();
  } catch (error) {
    emit('error', describeError(error));
    return null;
  } finally {
    state.ui.busy -= 1;
    emit('busy');
  }
}

export const store = {
  /** Every repository of the workspace, shown in the overview. */
  get repositories() { return state.repositories; },
  /** The repositories that have a tab open. */
  get tabs() { return state.repositories.filter((r) => !r.closed); },
  get active() { return state.active; },
  get ui() { return state.ui; },

  /** The repository shown, or null on the overview. */
  get activeRepo() {
    return state.repositories.find((r) => r.path === state.active) ?? null;
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  load(snapshot) {
    state.ui.refreshedAt = new Date();
    apply(snapshot);
  },

  async select(path) {
    if (path === state.active) return;
    // The tab changes at once; the fresh state of the repository follows.
    state.active = path;
    emit('workspace');
    const snapshot = await run(() => backend.selectRepository(path));
    if (snapshot) apply(snapshot);
  },

  /**
   * At startup, behind the splash screen: reads every repository, the one shown first, a few at a
   * time. `progress(done, total)` follows each one read.
   */
  async readAll(progress = () => {}) {
    const paths = state.repositories.map((r) => r.path);
    const order = [...paths.filter((p) => p === state.active), ...paths.filter((p) => p !== state.active)];
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < order.length) {
        const path = order[next];
        next += 1;
        try {
          apply(await backend.refresh(path));
        } catch {
          // Shown as unreadable by the snapshot of the next one.
        }
        done += 1;
        progress(done, order.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, order.length) }, worker));
    state.ui.refreshedAt = new Date();
  },

  /** Reads again one repository, or all of them (`path` null). */
  async refresh(path = null) {
    const snapshot = await run(() => backend.refresh(path));
    if (!snapshot) return;
    if (path === null) state.ui.refreshedAt = new Date();
    apply(snapshot);
  },

  /**
   * Adds repositories: from `paths` (dropped folders), or chosen in a folder dialog. `quiet`: no
   * notice when they were already there (they are simply shown).
   */
  async add(paths = null, { quiet = false } = {}) {
    const chosen = paths ?? (await run(() => backend.pickFolder()));
    if (!chosen?.length) return;
    const result = await run(() => backend.addRepositories(chosen));
    if (!result) return;
    apply(result.snapshot);
    const { added, existing } = result;
    if (quiet) return;
    if (added.length > 1) emit('notice', tn('notice.added', added.length));
    else if (added.length === 0 && existing > 1) emit('notice', tn('notice.alreadyThere', existing));
    else if (added.length === 0) emit('notice', t('notice.alreadyOpen'));
  },

  /**
   * Asks for a repository to clone, clones it, then adds it and opens its tab. `address`: already
   * chosen (a repository found on an account).
   */
  async clone(address = '') {
    const near = state.active ?? state.repositories[0]?.path ?? null;
    const path = await openCloneDialog({ near, address, find: () => store.find() });
    if (!path) return;
    await store.add([path], { quiet: true });
    emit('notice', t('clone.done', { path }));
  },

  /** Finds a repository on an account (with its README), then clones it. */
  async find() {
    const chosen = await openRepoFinder();
    if (chosen) await store.clone(chosen.address);
  },

  /** Closes the tab of a repository; it stays in the overview. */
  async close(path) {
    const snapshot = await run(() => backend.closeRepository(path));
    if (snapshot) apply(snapshot);
  },

  /**
   * Moves a tab to position `index` among the other open tabs; the workspace also holds closed
   * repositories, so the position is turned into one in the whole list.
   */
  async moveTab(path, index) {
    const others = store.tabs.filter((r) => r.path !== path);
    const all = state.repositories.filter((r) => r.path !== path);
    const target = index < others.length ? all.indexOf(others[index]) : all.indexOf(others[others.length - 1]) + 1;
    await store.reorder(path, Math.max(0, target));
  },

  /** Closes several tabs at once; their repositories stay in the overview. */
  async closeMany(paths) {
    if (!paths.length) return;
    const snapshot = await run(() => backend.closeRepositories(paths));
    if (snapshot) apply(snapshot);
  },

  /** Closes every tab but the pinned ones (and `keep`, when given). */
  async closeAll(keep = null) {
    await store.closeMany(store.tabs.filter((r) => !r.pinned && r.path !== keep).map((r) => r.path));
  },

  /** Closes the tabs after `path`, except the pinned ones. */
  async closeToTheRight(path) {
    const tabs = store.tabs;
    const index = tabs.findIndex((r) => r.path === path);
    await store.closeMany(tabs.slice(index + 1).filter((r) => !r.pinned).map((r) => r.path));
  },

  /** Pins a tab at the start of the tabs (opening it when closed), or unpins it. */
  async setPinned(path, pinned) {
    const snapshot = await run(() => backend.setRepositoryPinned(path, pinned));
    if (snapshot) apply(snapshot);
  },

  /**
   * Removes several repositories from the workspace (their folders are not touched), after asking:
   * all of them, or `paths` when given (those the overview shows).
   */
  async removeMany(paths = null) {
    const list = paths ?? state.repositories.map((r) => r.path);
    if (!list.length) return;
    const all = list.length === state.repositories.length;
    const ok = await confirm({
      title: all ? t('home.removeAllTitle') : tn('home.removeShownTitle', list.length),
      message: tn(all ? 'home.removeAllText' : 'home.removeShownText', list.length),
      confirmLabel: all ? t('home.removeAllConfirm') : tn('home.removeShownConfirm', list.length),
      danger: true,
    });
    if (!ok) return;
    const snapshot = await run(() => backend.removeRepositories(list));
    if (snapshot) apply(snapshot);
  },

  async remove(path) {
    const snapshot = await run(() => backend.removeRepository(path));
    if (snapshot) apply(snapshot);
  },

  async reorder(path, index) {
    const snapshot = await run(() => backend.reorderRepository(path, index));
    if (snapshot) apply(snapshot);
  },

  /** `color`: « #rrggbb », or null for the colour derived from the name. */
  async setColor(path, color) {
    const snapshot = await run(() => backend.setRepositoryColor(path, color));
    if (snapshot) apply(snapshot);
  },

  /** Sections of the overview, in order: { name, collapsed }. */
  get sections() { return state.sections; },

  get othersCollapsed() { return state.othersCollapsed; },

  /**
   * Asks for the name of a new section; with `paths`, those repositories are filed under it. Resolves
   * with the name, or null.
   */
  async newSection(paths = []) {
    const taken = (name) => state.sections.some((s) => s.name === name.trim());
    const answer = await prompt({
      title: t('sections.newTitle'),
      message: paths.length ? tn('sections.newText', paths.length) : null,
      label: t('sections.name'),
      placeholder: t('sections.namePlaceholder'),
      confirmLabel: t('sections.create'),
      validate: (name) => (!name.trim() ? t('sections.nameEmpty') : taken(name) ? t('sections.nameTaken') : null),
    });
    if (!answer) return null;
    const name = answer.value.trim();
    const snapshot = await run(() => (paths.length ? backend.setRepositoriesSection(paths, name) : backend.addSection(name)));
    if (snapshot) apply(snapshot);
    return snapshot ? name : null;
  },

  async renameSection(name) {
    const taken = (value) => value.trim() !== name && state.sections.some((s) => s.name === value.trim());
    const answer = await prompt({
      title: t('sections.renameTitle'),
      label: t('sections.name'),
      value: name,
      confirmLabel: t('sections.rename'),
      validate: (value) => (!value.trim() ? t('sections.nameEmpty') : taken(value) ? t('sections.nameTaken') : null),
    });
    if (!answer || answer.value.trim() === name) return;
    const snapshot = await run(() => backend.renameSection(name, answer.value));
    if (snapshot) apply(snapshot);
  },

  /** Removes a section after asking when it holds repositories; they go back with the others. */
  async removeSection(name) {
    const count = state.repositories.filter((r) => r.section === name).length;
    if (count > 0) {
      const ok = await confirm({
        title: t('sections.removeTitle', { name }),
        message: tn('sections.removeText', count),
        confirmLabel: t('sections.remove'),
      });
      if (!ok) return;
    }
    const snapshot = await run(() => backend.removeSection(name));
    if (snapshot) apply(snapshot);
  },

  async moveSection(name, index) {
    const snapshot = await run(() => backend.moveSection(name, index));
    if (snapshot) apply(snapshot);
  },

  /** Folds or unfolds a section; null is the group of repositories in no section. */
  async toggleSection(name) {
    const collapsed = name === null ? state.othersCollapsed : Boolean(state.sections.find((s) => s.name === name)?.collapsed);
    const snapshot = await run(() => backend.setSectionCollapsed(name, !collapsed));
    if (snapshot) apply(snapshot);
  },

  /** Files repositories under a section (null: under none). */
  async setSection(paths, name) {
    if (!paths.length) return;
    const snapshot = await run(() => backend.setRepositoriesSection(paths, name));
    if (snapshot) apply(snapshot);
  },

  async openFolder(path) {
    await run(() => backend.openFolder(path));
  },

  async openInVsCode(path) {
    await run(() => backend.openInVsCode(path));
  },

  /** A command of the repository view returned a new snapshot. */
  applySnapshot(snapshot) {
    apply(snapshot);
  },

  /** Shows a message to the user (`error`: a failure, shown longer). */
  notify(message, error = false) {
    emit(error ? 'error' : 'notice', message);
  },

  setSearch(text) {
    state.ui.search = text;
    emit('ui');
  },

  setFilter(filter) {
    state.ui.filter = filter;
    emit('ui');
  },
};

// State of the interface: the last snapshot received from the backend (the repositories of the
// workspace and their state) and what belongs to the display only (busy indicator, overview filter).
//
// Every change goes through a backend command, which returns a new snapshot.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { t, tn } from '../i18n/i18n.js';

const listeners = new Set();

const state = {
  repositories: [],
  /** Path of the repository shown; null for the overview. */
  active: null,
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
  get repositories() { return state.repositories; },
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

  /** Reads again one repository, or all of them (`path` null). */
  async refresh(path = null) {
    const snapshot = await run(() => backend.refresh(path));
    if (!snapshot) return;
    if (path === null) state.ui.refreshedAt = new Date();
    apply(snapshot);
  },

  /** Adds repositories: from `paths` (dropped folders), or chosen in a folder dialog. */
  async add(paths = null) {
    const chosen = paths ?? (await run(() => backend.pickFolder()));
    if (!chosen?.length) return;
    const result = await run(() => backend.addRepositories(chosen));
    if (!result) return;
    apply(result.snapshot);
    const { added, existing } = result;
    if (added.length > 1) emit('notice', tn('notice.added', added.length));
    else if (added.length === 0 && existing > 1) emit('notice', tn('notice.alreadyThere', existing));
    else if (added.length === 0) emit('notice', t('notice.alreadyOpen'));
  },

  async remove(path) {
    const snapshot = await run(() => backend.removeRepository(path));
    if (snapshot) apply(snapshot);
  },

  async reorder(path, index) {
    const snapshot = await run(() => backend.reorderRepository(path, index));
    if (snapshot) apply(snapshot);
  },

  async openFolder(path) {
    await run(() => backend.openFolder(path));
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

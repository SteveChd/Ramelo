// The pull request open in the centre of a repository, in place of the graph: its conversation, its
// changes (all of them, or those of one of its commits) and its commits. Merging, closing and
// commenting go to the service, after which the list of the repository is read again.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { choose, confirm } from '../components/dialog.js';
import { t } from '../i18n/i18n.js';
import { pulls } from './pulls.js';
import { repoStore } from './repo-store.js';
import { store } from './store.js';

const listeners = new Set();

const state = {
  /** Repository and number of the pull request shown; `number` null: none is shown. */
  path: null,
  number: null,
  /** 'conversation', 'changes' or 'commits'. */
  tab: 'conversation',
  /** { details, comments } from the service. */
  view: null,
  loading: false,
  error: null,
  /** { loading, data: { base, head, commits, files }, error }, read when first shown. */
  changes: null,
  /** Oid of the commit whose changes are shown; null: those of the whole pull request. */
  commit: null,
  /** Details of that commit (with its files), once read. */
  commitDetails: null,
  /** What is being sent: 'comment', 'merge' or 'close'. */
  busy: null,
};

/** The comment being written, kept per pull request while the application runs. */
const drafts = new Map();

function emit() {
  for (const listener of listeners) listener(state);
}

const current = (path, number) => state.path === path && state.number === number;

async function loadChanges() {
  const { path, number } = state;
  state.changes = { loading: true, data: null, error: null };
  emit();
  try {
    const data = await backend.pullRequestChanges(path, number);
    if (current(path, number)) state.changes = { loading: false, data, error: null };
  } catch (error) {
    if (current(path, number)) state.changes = { loading: false, data: null, error };
  }
  emit();
}

/** Sends a change to the service; the pull request is then shown as it answered. */
async function send(busy, call) {
  const { path, number } = state;
  state.busy = busy;
  emit();
  try {
    const view = await call();
    if (current(path, number)) state.view = view;
    return true;
  } catch (error) {
    store.notify(describeError(error), true);
    return false;
  } finally {
    if (current(path, number)) state.busy = null;
    emit();
    pulls.reload(path);
  }
}

export const pullView = {
  get state() { return state; },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  get draft() {
    return drafts.get(`${state.path}#${state.number}`) ?? '';
  },

  setDraft(text) {
    drafts.set(`${state.path}#${state.number}`, text);
  },

  async open(path, number) {
    if (current(path, number)) return;
    Object.assign(state, { path, number, tab: 'conversation', view: null, loading: true, error: null, changes: null, commit: null, commitDetails: null, busy: null });
    if (repoStore.state.diff?.kind === 'range') repoStore.closeDiff();
    emit();
    try {
      const view = await backend.pullRequest(path, number);
      if (current(path, number)) state.view = view;
    } catch (error) {
      if (current(path, number)) state.error = error;
    }
    if (current(path, number)) state.loading = false;
    emit();
  },

  /** Back to the graph. */
  close() {
    if (state.number === null) return;
    Object.assign(state, { path: null, number: null, view: null, changes: null, commit: null, commitDetails: null, busy: null, error: null });
    if (['range', 'commit'].includes(repoStore.state.diff?.kind)) repoStore.closeDiff();
    emit();
  },

  /** Reads the pull request again (it may have changed on the service). */
  async reload() {
    const { path, number } = state;
    if (number === null) return;
    state.loading = true;
    emit();
    try {
      const view = await backend.pullRequest(path, number);
      if (current(path, number)) Object.assign(state, { view, error: null });
    } catch (error) {
      if (current(path, number)) state.error = error;
    }
    if (current(path, number)) state.loading = false;
    if (state.changes && current(path, number)) await loadChanges();
    else emit();
  },

  setTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    emit();
    if (tab !== 'conversation' && !state.changes) loadChanges();
  },

  /** Shows the changes of one commit (`oid`), or of the whole pull request (null). */
  async showCommit(oid) {
    state.tab = 'changes';
    state.commit = oid;
    state.commitDetails = null;
    emit();
    if (!state.changes) await loadChanges();
    if (!oid) return;
    const { path, number } = state;
    try {
      const details = await backend.commitDetails(path, oid);
      if (current(path, number) && state.commit === oid) state.commitDetails = details;
    } catch (error) {
      store.notify(describeError(error), true);
    }
    emit();
  },

  /** Opens the diff of one file of the changes shown, below. */
  openFile(file) {
    const data = state.changes?.data;
    if (!data) return;
    if (state.commit) repoStore.openChangeDiff(file, state.commit);
    else repoStore.openChangeDiff(file, data.head, data.base);
  },

  async comment() {
    const text = pullView.draft;
    if (!text.trim() || state.busy) return;
    const { path, number } = state;
    if (await send('comment', () => backend.commentPullRequest(path, number, text))) drafts.delete(`${path}#${number}`);
  },

  async merge() {
    const details = state.view?.details;
    if (!details || state.busy) return;
    const methods = details.mergeMethods?.length ? details.mergeMethods : ['merge'];
    const target = details.targetBranch;
    const method = methods.length === 1
      ? ((await confirm({ title: t('pr.mergeTitle', { number: details.number }), message: t(`pr.method.${methods[0]}Hint`, { target }), confirmLabel: t('pr.merge') })) ? methods[0] : null)
      : await choose({
        title: t('pr.mergeTitle', { number: details.number }),
        message: t('pr.mergeText', { source: details.sourceBranch, target }),
        choices: methods.map((m, i) => ({ value: m, label: t(`pr.method.${m}`), hint: t(`pr.method.${m}Hint`, { target }), primary: i === 0 })),
      });
    if (!method) return;
    const { path, number } = state;
    if (await send('merge', () => backend.mergePullRequest(path, number, method, null))) {
      // The target branch moved on the remote: fetched, so that the graph shows the merge.
      repoStore.fetch();
    }
  },

  async closePull() {
    const details = state.view?.details;
    if (!details || state.busy) return;
    const ok = await confirm({
      title: t('pr.closeTitle', { number: details.number }),
      message: t('pr.closeText'),
      confirmLabel: t('pr.close'),
      danger: true,
    });
    if (!ok) return;
    const { path, number } = state;
    if (await send('close', () => backend.closePullRequest(path, number))) store.notify(t('pr.closed', { number }));
  },
};

// Another repository shown: its pull request view starts closed.
store.subscribe((topic) => {
  if (topic === 'workspace' && state.number !== null && store.active !== state.path) pullView.close();
});

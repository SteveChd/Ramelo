// State of the repository shown in the active tab: its history and graph, its branches, what is
// selected (the working copy or a commit), the diff open in the centre, and the commit being written.
//
// Each change is a backend command; it returns a new snapshot of the workspace, after which the
// history and the branches are read again.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { choose, confirm, prompt } from '../components/dialog.js';
import { t, tn } from '../i18n/i18n.js';
import { defaultMode, fileKind } from '../lib/file-kinds.js';
import { store } from './store.js';

/** Commits read at first, then added each time the end of the list is reached. */
const PAGE = 400;

const listeners = new Set();

const state = {
  path: null,
  history: null,
  limit: PAGE,
  refs: null,
  /** 'wip' for the working copy, otherwise the oid of the selected commit. */
  selection: 'wip',
  details: null,
  /**
   * Diff shown below the graph: { kind: 'worktree' | 'commit', file, staged, untracked, oid, data,
   * loading, mode: 'diff' | 'preview', versions }. `versions` (the file before and after, for an
   * image or a preview) is read when the preview is first shown.
   */
  diff: null,
  /** Long command in progress ('fetch', 'pull', 'push', 'commit'…), for the busy buttons. */
  running: null,
  /** Commit to bring into view in the graph (see `revealHead`). */
  reveal: null,
  /** What the history was read for: when HEAD or the branches move, it is read again. */
  loadedFor: null,
};

/** True while a snapshot of our own change is being applied (see `afterChange`). */
let applying = false;

/** Commit message being written, kept per repository while the application runs. */
const drafts = new Map();

/**
 * `topic`: 'history', 'refs', 'selection', 'details', 'diff', 'running', 'draft' or 'reveal'.
 */
function emit(topic) {
  for (const listener of listeners) listener(topic, state);
}

/** Runs a backend call; returns { value } or { error } (the error is not shown). */
async function attempt(call) {
  try {
    return { value: await call() };
  } catch (error) {
    return { error };
  }
}

/** Like `attempt`, with the busy state of a long command (`running`: 'fetch', 'push'…) shown meanwhile. */
async function attemptRunning(call, running) {
  if (!running) return attempt(call);
  state.running = running;
  emit('running');
  const result = await attempt(call);
  state.running = null;
  emit('running');
  return result;
}

/** Runs a backend call and shows a failure to the user; returns the value or null. */
async function run(call, running = null) {
  const { value, error } = await attemptRunning(call, running);
  if (error) {
    store.notify(describeError(error), true);
    return null;
  }
  return value;
}

function repo() {
  return store.repositories.find((r) => r.path === state.path) ?? null;
}

/** Summary of what the graph depends on: HEAD, the branch, the counts with the upstream. */
function fingerprint(r) {
  const s = r?.summary;
  return s ? [s.head.oid, s.head.branch, s.ahead, s.behind, s.upstream, s.lastCommit?.oid].join('|') : null;
}

async function loadHistory() {
  const path = state.path;
  const history = await run(() => backend.history(path, state.limit));
  if (path !== state.path || !history) return;
  state.history = history;
  emit('history');
}

async function loadRefs() {
  const path = state.path;
  const refs = await run(() => backend.branches(path));
  if (path !== state.path || !refs) return;
  state.refs = refs;
  emit('refs');
}

/** After a change: the snapshot goes to the workspace, then the history and the open diff follow. */
async function afterChange(snapshot) {
  if (!snapshot) return;
  // The workspace re-renders with the snapshot; the reloads below are not to be started twice.
  applying = true;
  store.applySnapshot(snapshot);
  applying = false;
  state.loadedFor = fingerprint(repo());
  await Promise.all([loadHistory(), loadRefs(), reloadDiff()]);
}

async function reloadDiff() {
  const diff = state.diff;
  if (!diff || diff.kind !== 'worktree') return;
  const data = await run(() => backend.fileDiff(state.path, diff.file, diff.staged, diff.untracked));
  if (state.diff !== diff) return;
  // Nothing left on this side of the file (all staged, or all discarded): the diff closes.
  if (!data) {
    state.diff = null;
  } else {
    state.diff = { ...diff, data, versions: null };
  }
  emit('diff');
  if (state.diff?.mode === 'preview') loadVersions();
}

/** Which file and side a diff shows; a diff read again keeps it. */
const diffKey = (d) => d && `${d.kind}\u0000${d.oid ?? ''}\u0000${Boolean(d.staged)}\u0000${d.file}`;

/** Reads the file before and after the change, for the preview of the open diff. */
let versionsFor = null;
async function loadVersions() {
  const diff = state.diff;
  const key = diffKey(diff);
  if (!diff || diff.versions || versionsFor === key) return;
  versionsFor = key;
  const commit = diff.kind === 'commit' ? diff.oid : null;
  const versions = await run(() => backend.fileVersions(state.path, diff.file, diff.data?.oldPath ?? null, commit, Boolean(diff.staged)));
  if (versionsFor === key) versionsFor = null;
  if (diffKey(state.diff) !== key) return;
  state.diff = { ...state.diff, versions: versions ?? { before: null, after: null, failed: true } };
  emit('diff');
}

/** Beyond this many commits, a commit to reveal is not looked for further down the history. */
const REVEAL_LIMIT = 20000;

/** Reads more history until `oid` is in it (or the limit is reached); true when it is. */
async function loadUntil(oid) {
  const has = () => state.history?.rows.some((r) => r.oid === oid);
  while (!has() && state.history?.hasMore && state.limit < REVEAL_LIMIT) {
    state.limit *= 2;
    await loadHistory();
  }
  return has();
}

/** Brings a commit into the middle of the graph, reading more history first when needed. */
async function reveal(oid, { select = true } = {}) {
  if (!(await loadUntil(oid))) return false;
  if (select) repoStore.selectCommit(oid);
  state.reveal = oid;
  emit('reveal');
  return true;
}

/**
 * After a switch of branch, the graph shows where HEAD now is: its commit is brought into view and,
 * when there is nothing to commit, selected. An old branch can be beyond the commits read so far:
 * more are read until it shows.
 */
function revealHead() {
  const summary = repo()?.summary;
  if (summary?.head.oid) reveal(summary.head.oid, { select: summary.fileCount === 0 });
}

function draft() {
  if (!drafts.has(state.path)) drafts.set(state.path, { summary: '', body: '', amend: false, saved: null });
  return drafts.get(state.path);
}

export const repoStore = {
  get state() { return state; },
  get draft() { return draft(); },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** The tab shows another repository: everything is read for it. */
  open(path) {
    Object.assign(state, { path, history: null, limit: PAGE, refs: null, selection: 'wip', details: null, diff: null, running: null });
    state.loadedFor = fingerprint(repo());
    emit('selection');
    loadHistory();
    loadRefs();
  },

  /** The workspace was refreshed (focus, F5…): the history is read again if the repository moved. */
  workspaceChanged() {
    if (!state.path || applying) return;
    const now = fingerprint(repo());
    if (now !== state.loadedFor) {
      state.loadedFor = now;
      loadHistory();
      loadRefs();
    }
    reloadDiff();
  },

  /** Selects a commit and brings it into view (a search result, a parent…). */
  reveal(oid, options) {
    return reveal(oid, options);
  },

  /** Reads history until the oldest of `oids` is in it, as far as the reveal limit allows. */
  async loadUntil(oids) {
    for (const oid of [...oids].reverse()) {
      if (await loadUntil(oid)) return;
    }
  },

  async loadMore() {
    if (!state.history?.hasMore) return;
    state.limit += PAGE;
    await loadHistory();
  },

  // ---------- Selection and diffs ----------

  selectWip() {
    state.selection = 'wip';
    state.details = null;
    emit('selection');
  },

  async selectCommit(oid) {
    if (state.selection === oid) return;
    state.selection = oid;
    state.details = null;
    if (state.diff?.kind === 'commit') state.diff = null;
    emit('selection');
    const details = await run(() => backend.commitDetails(state.path, oid));
    if (state.selection !== oid || !details) return;
    state.details = details;
    emit('details');
  },

  async openWorktreeDiff(file, staged, untracked) {
    const diff = { kind: 'worktree', file, staged, untracked, data: null, loading: true, mode: defaultMode(file), versions: null };
    state.diff = diff;
    emit('diff');
    const data = await run(() => backend.fileDiff(state.path, file, staged, untracked));
    if (state.diff !== diff) return;
    state.diff = { ...diff, data, loading: false };
    emit('diff');
    if (state.diff.mode === 'preview') loadVersions();
  },

  async openCommitDiff(file) {
    const details = state.details;
    if (!details) return;
    const known = details.files.find((f) => f.path === file);
    const diff = { kind: 'commit', file, oid: details.oid, data: known, loading: Boolean(known?.truncated), mode: defaultMode(file), versions: null };
    state.diff = diff;
    emit('diff');
    if (diff.mode === 'preview') loadVersions();
    if (!known?.truncated) return;
    const data = await run(() => backend.commitFileDiff(state.path, details.oid, file));
    if (state.diff !== diff) return;
    state.diff = { ...diff, data: data ?? known, loading: false };
    emit('diff');
  },

  /** Diff or formatted preview of the open file (images, Markdown, HTML). */
  setDiffMode(mode) {
    if (!state.diff || !fileKind(state.diff.file) || state.diff.mode === mode) return;
    state.diff = { ...state.diff, mode };
    emit('diff');
    if (mode === 'preview') loadVersions();
  },

  closeDiff() {
    state.diff = null;
    emit('diff');
  },

  // ---------- Working copy ----------

  async stage(files) {
    await afterChange(await run(() => backend.stage(state.path, files)));
  },

  async stageAll() {
    await afterChange(await run(() => backend.stageAll(state.path)));
  },

  async unstage(files) {
    await afterChange(await run(() => backend.unstage(state.path, files)));
  },

  async unstageAll() {
    await afterChange(await run(() => backend.unstageAll(state.path)));
  },

  /** `files`: entries of the summary ({ path, worktree }). Asks first: this cannot be undone. */
  async discard(files) {
    if (!files.length) return;
    const ok = await confirm({
      title: t('discard.title'),
      message: files.length === 1 ? t('discard.one', { path: files[0].path }) : tn('discard.many', files.length),
      confirmLabel: t('discard.confirm'),
      danger: true,
    });
    if (!ok) return;
    const tracked = files.filter((f) => f.worktree !== 'untracked').map((f) => f.path);
    const untracked = files.filter((f) => f.worktree === 'untracked').map((f) => f.path);
    await afterChange(await run(() => backend.discard(state.path, tracked, untracked)));
  },

  /** Stages, unstages or discards one hunk of the diff open in the centre. */
  async hunk(index, action) {
    const diff = state.diff;
    if (diff?.kind !== 'worktree' || !diff.data) return;
    if (action === 'discard') {
      const ok = await confirm({ title: t('discard.hunkTitle'), message: t('discard.hunk'), confirmLabel: t('discard.confirm'), danger: true });
      if (!ok) return;
    }
    const header = diff.data.hunks[index]?.header;
    await afterChange(await run(() => backend.applyHunk(state.path, diff.file, diff.untracked, index, header, action)));
  },

  setDraft(patch) {
    Object.assign(draft(), patch);
  },

  /** Ticking « amend » starts from the last commit's message, unticking brings back the draft. */
  async setAmend(amend) {
    const d = draft();
    d.amend = amend;
    if (amend) {
      d.saved = { summary: d.summary, body: d.body };
      const message = await run(() => backend.lastMessage(state.path));
      if (message && d.amend) {
        const [summary, ...rest] = message.split('\n');
        Object.assign(d, { summary, body: rest.join('\n').replace(/^\n+/, '') });
      }
    } else if (d.saved) {
      Object.assign(d, d.saved, { saved: null });
    }
    emit('draft');
  },

  async commit() {
    const d = draft();
    const r = repo();
    const s = r?.summary;
    if (!s || !d.summary.trim()) return;
    const message = d.body.trim() ? `${d.summary.trim()}\n\n${d.body.trim()}\n` : `${d.summary.trim()}\n`;
    // Nothing staged: everything is committed, as the button says.
    const stageAll = !d.amend && s.staged === 0;
    const result = await run(() => backend.commit(state.path, message, d.amend, stageAll), 'commit');
    if (!result) return;
    drafts.delete(state.path);
    emit('draft');
    store.notify(t(d.amend ? 'notice.amended' : 'notice.committed', { oid: result.oid.slice(0, 7) }));
    await afterChange(result.snapshot);
  },

  // ---------- Branches ----------

  /** Switches to `target`. When local changes are in the way, offers to bring them along. */
  async switchTo(target, carry = false) {
    const first = await attemptRunning(() => backend.switchBranch(state.path, target, carry), 'switch');
    let result = first.value;
    if (first.error?.code === 'local_changes' && !carry) {
      const answer = await choose({
        title: t('switch.blockedTitle', { target }),
        message: t('switch.blocked'),
        choices: [{ value: 'carry', label: t('switch.carry'), hint: t('switch.carryHint'), primary: true }],
      });
      if (answer !== 'carry') return;
      result = await run(() => backend.switchBranch(state.path, target, true), 'switch');
    } else if (first.error) {
      store.notify(describeError(first.error), true);
      return;
    }
    if (!result) return;
    if (result.carried === 'conflicted') store.notify(t('switch.conflicted'), true);
    else if (result.carried === 'reapplied') store.notify(t('switch.carried', { target }));
    state.selection = 'wip';
    state.diff = null;
    emit('selection');
    await afterChange(result.snapshot);
    revealHead();
  },

  /**
   * Asks for a name and creates a branch at `start` (an oid; HEAD when null), switching to it by
   * default. Local changes are put aside and brought back on the new branch, whatever its commit.
   */
  async createBranch(start = null) {
    const commit = start && state.history?.rows.find((r) => r.oid === start);
    const dirty = (repo()?.summary?.fileCount ?? 0) > 0;
    const answer = await prompt({
      title: t('branch.newTitle'),
      message: start ? t('branch.newFrom', { oid: start.slice(0, 7), summary: commit?.summary ?? '' }) : null,
      label: t('branch.name'),
      placeholder: 'feature/my-change',
      confirmLabel: t('branch.create'),
      checks: [{ key: 'checkout', label: dirty ? t('branch.checkoutCarry') : t('branch.checkout'), checked: true }],
      // Spaces are the most common slip: they become dashes.
      validate: (value) => (value.trim() ? null : t('branch.nameMissing')),
    });
    if (!answer) return;
    const name = answer.value.trim().replace(/\s+/g, '-');
    const result = await run(() => backend.createBranch(state.path, name, start, answer.checks.checkout), 'branch');
    if (!result) return;
    if (result.carried === 'conflicted') store.notify(t('switch.conflicted'), true);
    else if (result.carried === 'reapplied') store.notify(t('branch.createdCarried', { name }));
    else store.notify(t('branch.created', { name }));
    if (answer.checks.checkout) {
      state.selection = 'wip';
      state.diff = null;
      emit('selection');
    }
    await afterChange(result.snapshot);
    if (answer.checks.checkout) revealHead();
  },

  async deleteBranch(name) {
    const ok = await confirm({ title: t('branch.deleteTitle'), message: t('branch.delete', { name }), confirmLabel: t('branch.deleteConfirm'), danger: true });
    if (!ok) return;
    const first = await attempt(() => backend.deleteBranch(state.path, name, false));
    if (first.error?.code === 'branch_not_merged') {
      const force = await confirm({ title: t('branch.deleteTitle'), message: t('branch.notMerged', { name }), confirmLabel: t('branch.deleteAnyway'), danger: true });
      if (!force) return;
      await afterChange(await run(() => backend.deleteBranch(state.path, name, true)));
      return;
    }
    if (first.error) {
      store.notify(describeError(first.error), true);
      return;
    }
    await afterChange(first.value);
  },

  // ---------- Remotes ----------

  async fetch() {
    const snapshot = await run(() => backend.fetch(state.path), 'fetch');
    if (snapshot) store.notify(t('notice.fetched'));
    await afterChange(snapshot);
  },

  /** Pulls; when the branch has diverged, asks whether to rebase (recommended) or merge. */
  async pull(mode = 'auto') {
    let { value, error } = await attemptRunning(() => backend.pull(state.path, mode), 'pull');
    if (error?.code === 'diverged') {
      const s = repo()?.summary;
      const choice = await choose({
        title: t('pull.divergedTitle'),
        message: t('pull.diverged', { ahead: s?.ahead ?? '?', behind: s?.behind ?? '?' }),
        choices: [
          { value: 'rebase', label: t('pull.rebase'), hint: t('pull.rebaseHint'), primary: true },
          { value: 'merge', label: t('pull.merge'), hint: t('pull.mergeHint') },
        ],
      });
      if (!choice) return;
      value = await run(() => backend.pull(state.path, choice), 'pull');
    } else if (error) {
      store.notify(describeError(error), true);
      // Stopped on conflicts: the repository changed all the same.
      if (error.code === 'conflicts') await afterChange(await run(() => backend.refresh(state.path)));
      return;
    }
    if (!value) return;
    const { kind, commits } = value.outcome;
    store.notify(kind === 'upToDate' ? t('pull.upToDate') : tn(`pull.done.${kind}`, commits));
    await afterChange(value.snapshot);
  },

  /** Pushes; when the remote has new commits, offers to pull first or to force (safely). */
  async push(force = false) {
    let { value, error } = await attemptRunning(() => backend.push(state.path, force), 'push');
    if (error?.code === 'push_rejected' && !force) {
      const choice = await choose({
        title: t('push.rejectedTitle'),
        message: t('push.rejected'),
        choices: [
          { value: 'pull', label: t('push.pullFirst'), hint: t('push.pullFirstHint'), primary: true },
          { value: 'force', label: t('push.force'), hint: t('push.forceHint'), danger: true },
        ],
      });
      if (choice === 'pull') {
        await this.pull('auto');
        if (repo()?.summary?.behind === 0) await this.push(false);
        return;
      }
      if (choice !== 'force') return;
      value = await run(() => backend.push(state.path, true), 'push');
    } else if (error) {
      store.notify(describeError(error), true);
      return;
    }
    if (!value) return;
    const { remote, branch, upstreamSet } = value.outcome;
    store.notify(t(upstreamSet ? 'push.doneNew' : 'push.done', { remote, branch }));
    await afterChange(value.snapshot);
  },
};

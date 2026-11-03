// State of the repository shown in the active tab: its history and graph, its branches, what is
// selected (the working copy or a commit), the diff open in the centre, and the commit being written.
//
// Each change is a backend command; it returns a new snapshot of the workspace, after which the
// history and the branches are read again.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { choose, confirm, editText, prompt } from '../components/dialog.js';
import { withHostTrust } from '../components/host-trust.js';
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
  /** Commits marked together (Ctrl+click, Shift+click), to be combined; empty: none. */
  marked: [],
  details: null,
  /**
   * Diff shown below the graph: { kind: 'worktree' | 'commit' | 'range', file, staged, untracked, oid,
   * base (for a range: where it starts, `oid` being where it ends), data, loading, mode: 'diff' |
   * 'preview', versions }. `versions` (the file before and after, for an
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
    // A first connection to an ssh server asks whether to trust it, then runs the call again.
    return { value: await withHostTrust(call) };
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
const diffKey = (d) => d && `${d.kind}\u0000${d.base ?? ''}\u0000${d.oid ?? ''}\u0000${Boolean(d.staged)}\u0000${d.file}`;

/** Reads the file before and after the change, for the preview of the open diff. */
let versionsFor = null;
async function loadVersions() {
  const diff = state.diff;
  const key = diffKey(diff);
  if (!diff || diff.versions || versionsFor === key) return;
  versionsFor = key;
  const commit = diff.kind === 'commit' || diff.kind === 'range' ? diff.oid : null;
  const base = diff.kind === 'range' ? diff.base : null;
  const versions = await run(() => backend.fileVersions(state.path, diff.file, diff.data?.oldPath ?? null, commit, Boolean(diff.staged), base));
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

// ---------- Rewriting history ----------

/** What rewriting a commit implies, or null (with the reason shown) when it cannot be rewritten. */
async function rewritable(oid) {
  const info = await run(() => backend.rewriteInfo(state.path, oid));
  if (!info) return null;
  if (!info.editable) {
    store.notify(t('rewrite.notInHistory'), true);
    return null;
  }
  return info;
}

/** Texts of the rewrite dialog: the commits written again, and the force push to come. */
function rewriteNotes(info) {
  return {
    notes: [info.descendants > 0 ? tn('rewrite.descendants', info.descendants) : t('rewrite.noDescendants')],
    warning: info.pushedTo.length ? t('rewrite.pushed', { remotes: info.pushedTo.slice(0, 3).join(', ') }) : null,
  };
}

/** After a rewrite: the new history shows, with the new version of the commit selected. */
async function afterRewrite(result, { pushedTo }) {
  store.notify(t(pushedTo.length ? 'rewrite.donePushed' : 'rewrite.done'));
  state.selection = 'wip';
  state.marked = [];
  state.details = null;
  state.diff = null;
  emit('selection');
  await afterChange(result.snapshot);
  await reveal(result.commit);
}

// ---------- Conflicts ----------

/** Marker lines git writes around a conflict; one left in a file means it is not resolved. */
const MARKER = /^(<{7}|>{7})( |$)/m;

/** The file a resolution gives: each conflict as chosen, or with markers while it is not. */
export function composeResolution(conflict, choices) {
  const { ours: oursSide, theirs: theirsSide } = conflict.sides;
  const label = (side, fallback) => side.name ?? side.oid?.slice(0, 7) ?? fallback;
  const ending = (text) => (text && !text.endsWith('\n') ? `${text}\n` : text);
  return conflict.segments.map((segment, i) => {
    if (segment.kind === 'common') return segment.text;
    const { ours, theirs } = segment;
    switch (choices[i]) {
      case 'ours': return ours;
      case 'theirs': return theirs;
      case 'both': return ending(ours) + theirs;
      case 'bothReversed': return ending(theirs) + ours;
      default: return `<<<<<<< ${label(oursSide, 'ours')}\n${ending(ours)}=======\n${ending(theirs)}>>>>>>> ${label(theirsSide, 'theirs')}\n`;
    }
  }).join('');
}

/** After a file is resolved: the next conflicted file opens, or the operation can go on. */
async function afterResolved(snapshot) {
  if (!snapshot) return;
  await afterChange(snapshot);
  const next = repo()?.summary?.files.find((f) => f.index === 'conflicted');
  if (next) {
    await repoStore.openConflict(next.path);
  } else {
    state.diff = null;
    emit('diff');
    const operation = repo()?.summary?.operation;
    store.notify(t(operation ? 'conflict.allResolved' : 'conflict.allResolvedNoOp'));
  }
}

/** After a step of the operation: done, or stopped on the conflicts of the next commit. */
async function afterStep(result, operation) {
  if (!result) return;
  await afterChange(result.snapshot);
  if (result.progress === 'done') {
    store.notify(t(`conflict.done.${operation}`));
    if (state.diff?.kind === 'conflict') {
      state.diff = null;
      emit('diff');
    }
    return;
  }
  store.notify(t('conflict.next'), true);
  const next = repo()?.summary?.files.find((f) => f.index === 'conflicted');
  if (next) await repoStore.openConflict(next.path);
}

/** Text of a file from its base64 content; null when it is not text (binary or not UTF-8). */
function decodeText(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
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
    Object.assign(state, { path, history: null, limit: PAGE, refs: null, selection: 'wip', marked: [], details: null, diff: null, running: null });
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
    state.marked = [];
    state.details = null;
    emit('selection');
  },

  /** Selects a commit; `keepMarks`: the commits marked stay marked (a right click on one of them). */
  async selectCommit(oid, { keepMarks = false } = {}) {
    if (!keepMarks && state.marked.length) {
      state.marked = [];
      if (state.selection === oid) emit('selection');
    }
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

  clearMarks() {
    if (!state.marked.length) return;
    state.marked = [];
    emit('selection');
  },

  /**
   * Marks commits to combine them: `range` false toggles `oid` (Ctrl+click), true marks every commit
   * from the selected one to `oid` (Shift+click). The selected commit counts as marked.
   */
  markCommit(oid, { range = false } = {}) {
    const rows = state.history?.rows ?? [];
    const anchor = state.selection !== 'wip' ? state.selection : null;
    let marked = state.marked.length ? [...state.marked] : anchor ? [anchor] : [];
    if (range && anchor) {
      const [from, to] = [rows.findIndex((r) => r.oid === anchor), rows.findIndex((r) => r.oid === oid)];
      if (from < 0 || to < 0) return;
      marked = rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((r) => r.oid);
    } else if (marked.includes(oid)) {
      marked = marked.filter((m) => m !== oid);
    } else {
      marked.push(oid);
    }
    state.marked = marked.length > 1 ? marked : [];
    emit('selection');
    if (!range && state.selection === 'wip') this.selectCommit(oid, { keepMarks: true });
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

  /**
   * A file of a pull request: `known` is its diff as read with the others; `base` and `head` are
   * where the changes start and end (a whole pull request), or `base` is null for one of its commits.
   */
  async openChangeDiff(known, head, base = null) {
    const file = known.path;
    const diff = base
      ? { kind: 'range', file, base, oid: head, data: known, loading: known.truncated, mode: defaultMode(file), versions: null }
      : { kind: 'commit', file, oid: head, pull: true, data: known, loading: known.truncated, mode: defaultMode(file), versions: null };
    state.diff = diff;
    emit('diff');
    if (diff.mode === 'preview') loadVersions();
    if (!known.truncated) return;
    const data = await run(() => (base ? backend.rangeFileDiff(state.path, base, head, file) : backend.commitFileDiff(state.path, head, file)));
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

  // ---------- Rewriting history ----------

  /** Edits the message of a commit of the current branch; the commits after it are written again. */
  async rewordCommit(oid) {
    const details = state.details?.oid === oid ? state.details : await run(() => backend.commitDetails(state.path, oid));
    if (!details) return;
    const info = await rewritable(oid);
    if (!info) return;
    const message = await editText({
      title: t('rewrite.rewordTitle', { oid: oid.slice(0, 7) }),
      ...rewriteNotes(info),
      value: details.message,
      confirmLabel: t('rewrite.reword'),
      validate: (value) => (value.trim() ? null : t('rewrite.messageMissing')),
    });
    if (message === null || message.trimEnd() === details.message.trimEnd()) return;
    const result = await run(() => backend.rewordCommit(state.path, oid, message), 'rewrite');
    if (result) await afterRewrite(result, info);
  },

  /** Edits a file as it is in a commit of the current branch; later changes to it are kept on top. */
  async editCommitFile(oid, file) {
    const info = await rewritable(oid);
    if (!info) return;
    const versions = await run(() => backend.fileVersions(state.path, file, null, oid, false));
    const after = versions?.after;
    if (!after) {
      store.notify(t('rewrite.fileMissing', { file }), true);
      return;
    }
    const text = after.data ? decodeText(after.data) : null;
    if (text === null) {
      store.notify(t(after.data ? 'rewrite.notText' : 'rewrite.tooLarge', { file }), true);
      return;
    }
    // The field works with \n only: Windows line endings are put back when saving.
    const crlf = text.includes('\r\n');
    const original = crlf ? text.replace(/\r\n/g, '\n') : text;
    const edited = await editText({
      title: t('rewrite.editTitle', { file, oid: oid.slice(0, 7) }),
      ...rewriteNotes(info),
      value: original,
      code: true,
      confirmLabel: t('rewrite.save'),
    });
    if (edited === null || edited === original) return;
    const content = crlf ? edited.replace(/\n/g, '\r\n') : edited;
    const result = await run(() => backend.editCommitFile(state.path, oid, file, content), 'rewrite');
    if (result) await afterRewrite(result, info);
  },

  /**
   * Combines a commit of the current branch with the one before it. A squash asks for the message
   * of the commit that results (both messages to start with); a fixup keeps the one of the commit
   * before.
   */
  async squashCommit(oid, { fixup = false } = {}) {
    const info = await rewritable(oid);
    if (!info) return;
    if (!info.squash) {
      store.notify(t('rewrite.cannotSquash'), true);
      return;
    }
    const { parent, pushedTo } = info.squash;
    const [child, before] = await Promise.all([oid, parent].map((sha) =>
      (state.details?.oid === sha ? state.details : run(() => backend.commitDetails(state.path, sha)))));
    if (!child || !before) return;
    const names = { oid: oid.slice(0, 7), parent: parent.slice(0, 7), summary: before.message.split('\n')[0].trim() };
    const notes = [t(fixup ? 'rewrite.fixupNote' : 'rewrite.squashNote', names), rewriteNotes(info).notes[0]];
    const warning = pushedTo.length ? t('rewrite.squashPushed', { remotes: pushedTo.slice(0, 3).join(', ') }) : null;
    let message = null;
    if (fixup) {
      const ok = await confirm({
        title: t('rewrite.fixupTitle', names),
        message: [...notes, warning].filter(Boolean).join(' '),
        confirmLabel: t('rewrite.fixup'),
        danger: Boolean(warning),
      });
      if (!ok) return;
    } else {
      message = await editText({
        title: t('rewrite.squashTitle', names),
        notes,
        warning,
        value: `${before.message.trimEnd()}\n\n${child.message.trimEnd()}\n`,
        confirmLabel: t('rewrite.squash'),
        validate: (value) => (value.trim() ? null : t('rewrite.messageMissing')),
      });
      if (message === null) return;
    }
    const result = await run(() => backend.squashCommit(state.path, oid, message), 'rewrite');
    if (result) await afterRewrite(result, info.squash);
  },

  /**
   * Combines commits that follow one another into the oldest of them: a squash asks for the message
   * (all of theirs to start with), a fixup keeps the one of the oldest.
   */
  async squashCommits(oids, { fixup = false } = {}) {
    // Newest first, as the graph shows them; each one's only parent must be the next.
    const order = (state.history?.rows ?? []).filter((r) => oids.includes(r.oid));
    const follow = order.length === oids.length && order.every((r, i) => i === order.length - 1 || (r.parents.length === 1 && r.parents[0] === order[i + 1].oid));
    if (order.length < 2 || !follow) {
      store.notify(t('rewrite.cannotSquashMany'), true);
      return;
    }
    const oldest = order.at(-1);
    const info = await rewritable(oldest.oid);
    if (!info) return;
    const details = await Promise.all(order.map((r) => (state.details?.oid === r.oid ? state.details : run(() => backend.commitDetails(state.path, r.oid)))));
    if (details.some((d) => !d)) return;
    const names = { n: order.length, oldest: oldest.oid.slice(0, 7), summary: details.at(-1).message.split('\n')[0].trim() };
    // The commits combined are not written again: only those after them.
    const { notes, warning } = rewriteNotes({ ...info, descendants: info.descendants - (order.length - 1) });
    const text = [t(fixup ? 'rewrite.fixupManyNote' : 'rewrite.squashManyNote', names), notes[0]];
    let message = null;
    if (fixup) {
      const ok = await confirm({
        title: t('rewrite.fixupManyTitle', names),
        message: [...text, warning].filter(Boolean).join(' '),
        confirmLabel: t('rewrite.fixup'),
        danger: Boolean(warning),
      });
      if (!ok) return;
    } else {
      message = await editText({
        title: t('rewrite.squashManyTitle', names),
        notes: text,
        warning,
        value: `${[...details].reverse().map((d) => d.message.trimEnd()).join('\n\n')}\n`,
        confirmLabel: t('rewrite.squash'),
        validate: (value) => (value.trim() ? null : t('rewrite.messageMissing')),
      });
      if (message === null) return;
    }
    const result = await run(() => backend.squashCommits(state.path, order.map((r) => r.oid), message), 'rewrite');
    if (result) await afterRewrite(result, info);
  },

  // ---------- Conflicts ----------

  /** Opens the conflict editor on a conflicted file of the working copy. */
  async openConflict(file) {
    const diff = { kind: 'conflict', file, loading: true, conflict: null, choices: [], result: '', edited: false };
    state.diff = diff;
    emit('diff');
    const conflict = await run(() => backend.conflictFile(state.path, file));
    if (state.diff !== diff) return;
    if (!conflict) {
      state.diff = null;
    } else {
      const choices = conflict.segments.map(() => null);
      state.diff = { ...diff, loading: false, conflict, choices, result: composeResolution(conflict, choices) };
    }
    emit('diff');
  },

  /**
   * How conflict `index` (of the segments) is settled: 'ours', 'theirs', 'both', 'bothReversed', or
   * null; `index` null settles them all. The result is written again from the choices.
   */
  chooseConflict(index, choice) {
    const diff = state.diff;
    if (diff?.kind !== 'conflict' || !diff.conflict) return;
    const choices = diff.conflict.segments.map((segment, i) => {
      if (segment.kind !== 'conflict') return null;
      return index === null || index === i ? choice : diff.choices[i];
    });
    state.diff = { ...diff, choices, result: composeResolution(diff.conflict, choices), edited: false };
    emit('diff');
  },

  /** The result typed by hand; kept without drawing the editor again. */
  editResolution(text) {
    if (state.diff?.kind !== 'conflict') return;
    state.diff.result = text;
    state.diff.edited = true;
  },

  /** Writes the result to the file and marks it resolved (asks first while markers are left). */
  async markResolved() {
    const diff = state.diff;
    if (diff?.kind !== 'conflict') return;
    if (MARKER.test(diff.result)) {
      const ok = await confirm({ title: t('conflict.markersTitle'), message: t('conflict.markersText'), confirmLabel: t('conflict.markResolved') });
      if (!ok) return;
    }
    await afterResolved(await run(() => backend.resolveConflict(state.path, diff.file, diff.result), 'resolve'));
  },

  /** Settles the file with one side as it is (or deleted, when that side deleted it). */
  async takeConflictSide(theirs) {
    const diff = state.diff;
    if (diff?.kind !== 'conflict') return;
    await afterResolved(await run(() => backend.takeConflictSide(state.path, diff.file, theirs), 'resolve'));
  },

  /** Settles the file by deleting it. */
  async deleteConflicted() {
    const diff = state.diff;
    if (diff?.kind !== 'conflict') return;
    await afterResolved(await run(() => backend.resolveConflict(state.path, diff.file, null), 'resolve'));
  },

  /** Goes on with the merge, rebase, cherry-pick or revert once its conflicts are resolved. */
  async continueOperation() {
    const operation = repo()?.summary?.operation;
    if (!operation) return;
    await afterStep(await run(() => backend.continueOperation(state.path), 'operation'), operation);
  },

  /** Leaves out the commit the rebase or the cherry-pick stopped on. */
  async skipCommit() {
    const operation = repo()?.summary?.operation;
    if (!operation) return;
    const ok = await confirm({ title: t('conflict.skipTitle'), message: t('conflict.skipText'), confirmLabel: t('conflict.skip'), danger: true });
    if (!ok) return;
    await afterStep(await run(() => backend.skipCommit(state.path), 'operation'), operation);
  },

  /** Gives up the operation: the branch goes back to where it was. */
  async abortOperation() {
    const operation = repo()?.summary?.operation;
    if (!operation) return;
    const ok = await confirm({
      title: t(`conflict.abortTitle.${operation}`),
      message: t(`conflict.abortText.${operation}`),
      confirmLabel: t(`conflict.abort.${operation}`),
      danger: true,
    });
    if (!ok) return;
    const snapshot = await run(() => backend.abortOperation(state.path), 'operation');
    if (!snapshot) return;
    if (state.diff?.kind === 'conflict') state.diff = null;
    emit('diff');
    await afterChange(snapshot);
    store.notify(t(`conflict.aborted.${operation}`));
  },

  // ---------- Branches ----------

  /**
   * A branch checked out in another worktree cannot be checked out here: offers to open that
   * worktree in its own tab, or to check out the branch's commit here, detached.
   */
  async branchInWorktree(name, folder) {
    const branch = state.refs?.local.find((b) => b.name === name);
    const answer = await choose({
      title: t('worktree.title', { name }),
      message: t('worktree.message', { name, folder }),
      choices: [
        { value: 'open', label: t('worktree.open'), hint: folder, primary: true },
        branch && { value: 'detach', label: t('worktree.detach'), hint: t('worktree.detachHint', { oid: branch.oid.slice(0, 7) }) },
      ].filter(Boolean),
    });
    if (answer === 'open') await store.add([folder], { quiet: true });
    if (answer === 'detach') await repoStore.switchTo(branch.oid);
  },

  /** Switches to `target`. When local changes are in the way, offers to bring them along. */
  async switchTo(target, carry = false) {
    const held = state.refs?.local.find((b) => b.name === target && b.worktree);
    if (held) {
      await repoStore.branchInWorktree(target, held.worktree);
      return;
    }
    const first = await attemptRunning(() => backend.switchBranch(state.path, target, carry), 'switch');
    let result = first.value;
    if (first.error?.code === 'branch_in_worktree') {
      const local = state.refs?.local.some((b) => b.name === target) ? target : target.split('/').slice(1).join('/');
      await repoStore.branchInWorktree(local, first.error.subject);
      return;
    }
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
    state.marked = [];
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
      state.marked = [];
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

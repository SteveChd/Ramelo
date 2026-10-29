// Diff of one file, in the panel below the graph: its hunks with old and new line numbers, in one
// column or side by side (before on the left, after on the right). For the working copy,
// each hunk can be staged, unstaged or discarded on its own, and the whole file as well. For the
// changes of a pull request, each line can be commented, and the comments are shown under their line.

import { t } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { shortcut } from '../../app/actions.js';
import { fileKind } from '../../lib/file-kinds.js';
import { markdown } from '../../lib/markdown.js';
import { relativeTime } from '../../lib/time.js';
import { layout } from '../../state/layout.js';
import { pullView } from '../../state/pull-view.js';
import { repoStore } from '../../state/repo-store.js';
import { store } from '../../state/store.js';
import { renderConflict } from './conflict-view.js';
import { diffKey } from './files.js';
import { renderPreview } from './preview.js';

function hunkActions(index) {
  const diff = repoStore.state.diff;
  if (diff.kind !== 'worktree' || diff.untracked) return null;
  const button = (label, action, extra = '') => h('button', { type: 'button', class: `btn${extra}`, onclick: () => repoStore.hunk(index, action) }, label);
  return diff.staged
    ? button(t('diff.unstageHunk'), 'unstage')
    : [button(t('diff.discardHunk'), 'discard'), button(t('diff.stageHunk'), 'stage', ' primary')];
}

function fileActions() {
  const diff = repoStore.state.diff;
  // A file of a past commit can be corrected there, unless the commit deleted it or it is binary.
  // A commit of a pull request is not in the local history: it cannot be edited from here.
  if (diff.kind === 'commit' && !diff.pull) {
    if (!diff.data || diff.data.status === 'deleted' || diff.data.binary) return null;
    return h('button', { type: 'button', class: 'btn', title: t('rewrite.editHint'), onclick: () => repoStore.editCommitFile(diff.oid, diff.file) }, icon('edit', 14), t('rewrite.editFile'));
  }
  if (diff.kind !== 'worktree') return null;
  const entry = store.activeRepo?.summary?.files.find((f) => f.path === diff.file);
  if (diff.staged) {
    return h('button', { type: 'button', class: 'btn', onclick: () => repoStore.unstage([diff.file]) }, icon('minus', 14), t('wip.unstage'));
  }
  return [
    entry && h('button', { type: 'button', class: 'btn', onclick: () => repoStore.discard([entry]) }, icon('remove', 14), t('wip.discard')),
    h('button', { type: 'button', class: 'btn primary', onclick: () => repoStore.stage([diff.file]) }, icon('plus', 14), t('wip.stage')),
  ];
}

const withKey = (label, action) => (shortcut(action) ? `${label} (${shortcut(action)})` : label);

/** Fold the panel to its header, or let it take the whole centre (and back). */
function panelButtons() {
  const { diffCollapsed, diffMaximized } = layout.state;
  const maximized = diffMaximized && !diffCollapsed;
  return [
    h('button', {
      type: 'button',
      class: `icon-btn fold${diffCollapsed ? ' folded' : ''}`,
      title: withKey(diffCollapsed ? t('diff.unfold') : t('diff.fold'), 'view.toggleDiff'),
      onclick: () => layout.toggle('diffCollapsed'),
    }, icon('chevron', 16)),
    h('button', {
      type: 'button',
      class: 'icon-btn',
      title: withKey(maximized ? t('diff.restore') : t('diff.maximize'), 'view.maximizeDiff'),
      onclick: () => layout.set({ diffMaximized: !maximized, diffCollapsed: false }),
    }, icon(maximized ? 'restore' : 'maximize', 15)),
  ];
}

/** Diff or preview, for the files that have one; an image (not SVG) has only its preview. */
function modeSwitch(diff) {
  const kind = fileKind(diff.file);
  if (!kind || kind === 'image') return null;
  return h('div', { class: 'seg mode-switch', role: 'group', 'aria-label': t('preview.mode') },
    [['diff', t('preview.diff')], ['preview', t('preview.preview')]].map(([mode, label]) => h('button', {
      type: 'button',
      'aria-pressed': String(diff.mode === mode),
      onclick: () => repoStore.setDiffMode(mode),
    }, label)));
}

/** One column, or the file before on the left and after on the right. */
function styleSwitch(diff) {
  if (diff.mode === 'preview' || !diff.data?.hunks?.length) return null;
  const split = layout.state.diffSplit;
  const key = shortcut('view.splitDiff');
  return h('div', { class: 'seg style-switch', role: 'group', 'aria-label': t('diff.style') },
    [[false, 'unified', t('diff.unified')], [true, 'split', t('diff.split')]].map(([value, iconName, label]) => h('button', {
      type: 'button',
      title: `${label}${key ? ` (${key})` : ''}`,
      'aria-pressed': String(split === value),
      onclick: () => layout.set({ diffSplit: value }),
    }, icon(iconName, 15))));
}

/** Lines added and removed; a file moved without change, or a binary file, says so instead. */
function stats(data) {
  if (!data) return null;
  if (data.binary) return h('span', { class: 'stats note' }, t('diff.binaryShort'));
  if (data.additions + data.deletions === 0) {
    return ['renamed', 'copied'].includes(data.status) ? h('span', { class: 'stats note' }, t('diff.sameContent')) : null;
  }
  return h('span', { class: 'stats' }, h('span', { class: 'add' }, `+${data.additions}`), ' ', h('span', { class: 'del' }, `−${data.deletions}`));
}

// ---------- Comments of a pull request on its lines ----------

/** The comment being written on a line: { key, text }, kept while other things are drawn. */
let composer = null;

/**
 * The pull request whose whole changes this diff shows, with its comments on this file; null for
 * any other diff (a commit of the pull request has other line numbers).
 */
function review(diff) {
  const s = pullView.state;
  const data = s.changes?.data;
  if (diff.kind !== 'range' || s.number === null || !s.view || !data || diff.base !== data.base || diff.oid !== data.head) return null;
  return {
    comments: s.view.comments.filter((c) => c.path === diff.file && c.line && !c.outdated),
    open: s.view.details.state === 'open',
  };
}

const lineKey = (l) => `${l.old ?? ''}:${l.new ?? ''}`;

/** A comment is on the side it was written on: the old line numbers for a removed line. */
function isOn(comment, l) {
  return comment.oldSide ? l.kind !== 'added' && l.old === comment.line : l.kind !== 'deleted' && l.new === comment.line;
}

function commentButton(l, rerender) {
  return h('button', {
    type: 'button',
    class: 'line-comment-btn',
    title: t('pr.commentLine'),
    onclick: () => {
      composer = { key: lineKey(l), text: '' };
      rerender();
    },
  }, icon('plus', 12, 2.6));
}

function lineComposer(l, data, rerender) {
  const busy = pullView.state.busy === 'line';
  const area = h('textarea', { class: 'pull-reply', placeholder: t('pr.commentPlaceholder'), spellcheck: 'true', disabled: busy });
  area.value = composer.text;
  const send = async () => {
    if (!area.value.trim() || pullView.state.busy) return;
    const sent = await pullView.commentLine({
      path: data.path,
      oldPath: data.oldPath ?? null,
      oldLine: l.kind === 'added' ? null : l.old,
      newLine: l.kind === 'deleted' ? null : l.new,
      body: area.value,
    });
    if (sent) composer = null;
    rerender();
  };
  area.addEventListener('input', () => { composer.text = area.value; });
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      composer = null;
      rerender();
    }
  });
  setTimeout(() => area.focus(), 0);
  return h('div', { class: 'line-thread composing' },
    area,
    h('div', { class: 'pull-composer-foot' },
      h('span', { class: 'hint' }, 'Ctrl+Enter'),
      h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: () => { composer = null; rerender(); } }, t('dialog.cancel')),
      h('button', { type: 'button', class: 'btn small primary', disabled: busy, onclick: send }, busy ? t('pr.sending') : t('pr.comment'))));
}

/** What follows a line: its comments, and the box to write one when it is open. */
function lineExtras(lines, rv, data, rerender) {
  if (!rv) return null;
  const comments = rv.comments.filter((c) => lines.some((l) => l && isOn(c, l)));
  const target = lines.find((l) => l && composer?.key === lineKey(l));
  return [
    comments.length > 0 && h('div', { class: 'line-thread' }, comments.map((c) => h('div', { class: 'line-comment' },
      h('header', {}, h('span', { class: 'who' }, icon('user', 12), c.author), c.created && h('time', {}, relativeTime(c.created))),
      markdown(c.body)))),
    target && lineComposer(target, data, rerender),
  ];
}

function line(l) {
  const sign = { added: '+', deleted: '−', context: '', noNewline: '' }[l.kind];
  return h('div', { class: `dline ${l.kind}` },
    h('span', { class: 'no' }, l.old ?? ''),
    h('span', { class: 'no' }, l.new ?? ''),
    h('span', { class: 'sign' }, sign),
    h('span', { class: 'code' }, l.kind === 'noNewline' ? t('diff.noNewline') : l.text));
}

/**
 * Rows of a hunk side by side: unchanged lines on both sides; removed lines on the left facing the
 * lines added in their place on the right, the shorter side padded with empty cells.
 */
function splitRows(lines) {
  const rows = [];
  let removed = [];
  let added = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i += 1) rows.push([removed[i] ?? null, added[i] ?? null]);
    removed = [];
    added = [];
  };
  let last = 'context';
  for (const l of lines) {
    if (l.kind === 'deleted') {
      if (added.length) flush();
      removed.push(l);
    } else if (l.kind === 'added') {
      added.push(l);
    } else if (l.kind === 'noNewline') {
      // Belongs to the line just before it: on its side, or on both for an unchanged line.
      if (last === 'deleted') removed.push(l);
      else if (last === 'added') added.push(l);
      else rows.push([l, l]);
      continue;
    } else {
      flush();
      rows.push([l, l]);
    }
    last = l.kind;
  }
  flush();
  return rows;
}

function half(l, side) {
  if (!l) return [h('span', { class: 'no empty' }), h('span', { class: 'sign empty' }), h('span', { class: 'code empty' })];
  const kind = l.kind === 'context' ? '' : ` ${l.kind}`;
  const sign = { added: '+', deleted: '−' }[l.kind] ?? '';
  return [
    h('span', { class: `no${kind}` }, (side === 'old' ? l.old : l.new) ?? ''),
    h('span', { class: `sign${kind}` }, sign),
    h('span', { class: `code${kind}` }, l.kind === 'noNewline' ? t('diff.noNewline') : l.text),
  ];
}

function splitLine([before, after]) {
  return h('div', { class: 'sline' }, half(before, 'old'), half(after, 'new'));
}

/** A line of the unified diff, with what a pull request adds to it. */
function reviewedLine(l, rv, data, rerender) {
  const row = line(l);
  if (!rv || l.kind === 'noNewline') return row;
  if (rv.open) row.append(commentButton(l, rerender));
  return [row, lineExtras([l], rv, data, rerender)];
}

/** A row of the side by side diff: a comment goes on its line after the changes, or before when removed. */
function reviewedRow(pair, rv, data, rerender) {
  const row = splitLine(pair);
  const [before, after] = pair;
  const target = after?.kind !== 'noNewline' && after ? after : before?.kind !== 'noNewline' ? before : null;
  if (!rv || !target) return row;
  if (rv.open) row.append(commentButton(target, rerender));
  return [row, lineExtras(before === after ? [before] : [before, after], rv, data, rerender)];
}

export function renderDiff(container) {
  const diff = repoStore.state.diff;
  if (diff.kind === 'conflict') {
    renderConflict(container);
    return;
  }
  const data = diff.data;
  const rv = review(diff);
  const rerender = () => renderDiff(container);
  // Drawn again for the same file (a comment sent): the place in the diff is kept.
  const key = diffKey(diff);
  const previous = container.querySelector('.diff-body');
  const scroll = container.dataset.key === key && previous ? [previous.scrollTop, previous.scrollLeft] : [0, 0];
  container.dataset.key = key ?? '';
  const sideLabel = diff.kind === 'commit' ? t('diff.inCommit', { oid: diff.oid.slice(0, 7) })
    : diff.kind === 'range' ? t('diff.inRange', { base: diff.base.slice(0, 7), head: diff.oid.slice(0, 7) }) : diff.staged ? t('diff.staged') : diff.untracked ? t('diff.untracked') : t('diff.unstaged');
  let body;
  if (diff.mode === 'preview') body = renderPreview(diff, () => renderDiff(container));
  else if (diff.loading && !data) body = h('div', { class: 'diff-note' }, t('repo.loading'));
  else if (!data) body = h('div', { class: 'diff-note' }, t('diff.none'));
  else if (data.binary) body = h('div', { class: 'diff-note' }, t('diff.binary'));
  else if (data.truncated) body = h('div', { class: 'diff-note' }, diff.loading ? t('repo.loading') : t('diff.tooLarge', { additions: data.additions, deletions: data.deletions }));
  else if (!data.hunks.length) body = h('div', { class: 'diff-note' }, t('diff.noContent'));
  else {
    body = data.hunks.map((hunk, index) => [
      h('div', { class: 'hunk-head' }, h('span', { class: 'h' }, hunk.header), hunkActions(index)),
      layout.state.diffSplit
        ? splitRows(hunk.lines).map((pair) => reviewedRow(pair, rv, data, rerender))
        : hunk.lines.map((l) => reviewedLine(l, rv, data, rerender)),
    ]);
  }
  mount(container, h('div', { class: 'diff' },
    h('div', {
      class: 'diff-head',
      ondblclick: (event) => { if (!event.target.closest('button')) layout.set({ diffMaximized: !layout.state.diffMaximized, diffCollapsed: false }); },
    },
      data?.status && h('span', { class: `change-badge ${data.status}` }, t(`change.${data.status}`)),
      h('span', { class: 'path', title: data?.oldPath ? `${data.oldPath} → ${diff.file}` : diff.file }, h('bdi', {}, diff.file)),
      data?.oldPath && h('span', { class: 'from-label' }, t('diff.from')),
      data?.oldPath && h('span', { class: 'from', title: data.oldPath }, h('bdi', {}, data.oldPath)),
      h('span', { class: 'side-label' }, sideLabel),
      modeSwitch(diff),
      styleSwitch(diff),
      stats(data),
      fileActions(),
      h('div', { class: 'vsep' }),
      panelButtons(),
      h('button', { type: 'button', class: 'icon-btn', title: t('diff.close'), onclick: () => repoStore.closeDiff() }, icon('close', 16))),
    h('div', { class: `diff-body${diff.mode === 'preview' ? ' preview' : ''}${layout.state.diffSplit ? ' split' : ''}${rv ? ' reviewed' : ''}` }, body)));
  const shown = container.querySelector('.diff-body');
  if (shown) [shown.scrollTop, shown.scrollLeft] = scroll;
}

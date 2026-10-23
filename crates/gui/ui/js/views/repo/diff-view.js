// Diff of one file, in the centre: its hunks with old and new line numbers. For the working copy,
// each hunk can be staged, unstaged or discarded on its own, and the whole file as well.

import { t } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { repoStore } from '../../state/repo-store.js';
import { store } from '../../state/store.js';

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

function line(l) {
  const sign = { added: '+', deleted: '−', context: '', noNewline: '' }[l.kind];
  return h('div', { class: `dline ${l.kind}` },
    h('span', { class: 'no' }, l.old ?? ''),
    h('span', { class: 'no' }, l.new ?? ''),
    h('span', { class: 'sign' }, sign),
    h('span', { class: 'code' }, l.kind === 'noNewline' ? t('diff.noNewline') : l.text));
}

export function renderDiff(container) {
  const diff = repoStore.state.diff;
  const data = diff.data;
  const sideLabel = diff.kind === 'commit' ? t('diff.inCommit', { oid: diff.oid.slice(0, 7) }) : diff.staged ? t('diff.staged') : diff.untracked ? t('diff.untracked') : t('diff.unstaged');
  let body;
  if (diff.loading && !data) body = h('div', { class: 'diff-note' }, t('repo.loading'));
  else if (!data) body = h('div', { class: 'diff-note' }, t('diff.none'));
  else if (data.binary) body = h('div', { class: 'diff-note' }, t('diff.binary'));
  else if (data.truncated) body = h('div', { class: 'diff-note' }, diff.loading ? t('repo.loading') : t('diff.tooLarge', { additions: data.additions, deletions: data.deletions }));
  else if (!data.hunks.length) body = h('div', { class: 'diff-note' }, t('diff.noContent'));
  else {
    body = data.hunks.map((hunk, index) => [
      h('div', { class: 'hunk-head' }, h('span', { class: 'h' }, hunk.header), hunkActions(index)),
      hunk.lines.map(line),
    ]);
  }
  mount(container, h('div', { class: 'diff' },
    h('div', { class: 'diff-head' },
      h('span', { class: 'path', title: diff.file },
        data?.oldPath && h('span', { class: 'from' }, `${data.oldPath} → `), diff.file),
      h('span', { class: 'side-label' }, sideLabel),
      data && !data.binary && h('span', { class: 'stats' }, h('span', { class: 'add' }, `+${data.additions}`), ' ', h('span', { class: 'del' }, `−${data.deletions}`)),
      fileActions(),
      h('button', { type: 'button', class: 'icon-btn', title: t('diff.close'), onclick: () => repoStore.closeDiff() }, icon('close', 16))),
    h('div', { class: 'diff-body' }, body)));
}

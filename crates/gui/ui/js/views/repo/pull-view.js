// A pull request, in the centre of the repository in place of the graph: its title and state with
// what can be done about it (merge, close), then three tabs. The conversation shows its description
// and comments with a box to answer; the changes list the files it changes, all together or for one
// of its commits, each opening its diff below; the commits list what it brings.

import { t, tn } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { markdown } from '../../lib/markdown.js';
import { fullDate, relativeTime } from '../../lib/time.js';
import * as backend from '../../api/backend.js';
import { describeError } from '../../app/errors.js';
import { pullView } from '../../state/pull-view.js';
import { repoStore } from '../../state/repo-store.js';
import { diffKey, fileRow } from './files.js';

/** State chip: open, draft, merged or closed. */
export function pullStateChip(pull) {
  const state = pull.state === 'open' && pull.draft ? 'draft' : pull.state;
  return h('span', { class: `pull-state ${state}` }, t(`pr.state.${state}`));
}

function when(seconds) {
  return h('time', { title: fullDate(seconds) }, relativeTime(seconds));
}

function head(details) {
  const { busy, loading } = pullView.state;
  const open = details.state === 'open';
  const blocked = details.draft ? t('pr.draftCannotMerge') : details.conflicts ? t('pr.conflicts') : null;
  return h('div', { class: 'pull-head' },
    h('div', { class: 'pull-top' },
      h('button', { type: 'button', class: 'btn pull-back', title: t('pr.backHint'), onclick: () => pullView.close() }, icon('chevron', 14, 2.2), t('pr.back')),
      h('h2', { class: 'pull-title' }, details.title, h('span', { class: 'pull-number' }, `#${details.number}`)),
      h('div', { class: 'pull-actions' },
        h('button', { type: 'button', class: `icon-btn${loading ? ' spinning' : ''}`, title: t('pr.reload'), disabled: loading, onclick: () => pullView.reload() }, icon('refresh', 15)),
        h('button', { type: 'button', class: 'icon-btn', title: t('pr.openWeb'), onclick: () => backend.openUrl(details.webUrl).catch(() => {}) }, icon('external', 15)),
        open && h('button', { type: 'button', class: 'btn danger', disabled: Boolean(busy), onclick: () => pullView.closePull() },
          busy === 'close' ? t('pr.closing') : t('pr.close')),
        open && h('button', {
          type: 'button',
          class: 'btn primary',
          disabled: Boolean(busy) || Boolean(blocked),
          title: blocked,
          onclick: () => pullView.merge(),
        }, icon('pull', 14), busy === 'merge' ? t('pr.merging') : t('pr.merge')))),
    h('div', { class: 'pull-meta' },
      pullStateChip(details),
      h('span', {}, t('pr.wantsToMerge', { author: details.author })),
      h('span', { class: 'ref-chip', title: details.sourceRepo ?? '' }, details.sourceRepo ? `${details.sourceRepo}:${details.sourceBranch}` : details.sourceBranch),
      h('span', { class: 'muted' }, '→'),
      h('span', { class: 'ref-chip target' }, details.targetBranch),
      h('span', { class: 'muted' }, '·'),
      when(details.created),
      open && !details.draft && details.conflicts && h('span', { class: 'pull-warn' }, icon('warning', 13), t('pr.conflicts')),
      details.reviewers?.length > 0 && h('span', { class: 'muted' }, t('pr.reviewers', { names: details.reviewers.join(', ') }))));
}

function tabs(details) {
  const { tab, changes } = pullView.state;
  const data = changes?.data;
  const tabButton = (key, label, count) => h('button', {
    type: 'button',
    role: 'tab',
    'aria-selected': String(tab === key),
    onclick: () => pullView.setTab(key),
  }, label, count !== null && count !== undefined && h('span', { class: 'n' }, count));
  return h('div', { class: 'pull-tabs', role: 'tablist' },
    tabButton('conversation', t('pr.tab.conversation'), pullView.state.view?.comments.length ?? details.comments),
    tabButton('changes', t('pr.tab.changes'), data?.files.length),
    tabButton('commits', t('pr.tab.commits'), data?.commits.length));
}

function post({ author, created, body, path, line }, description = false) {
  return h('article', { class: `pull-post${description ? ' description' : ''}` },
    h('header', {},
      h('span', { class: 'who' }, icon('user', 13), author),
      when(created),
      path && h('span', { class: 'on-file', title: path }, icon('commit', 12), line ? `${path}:${line}` : path)),
    body?.trim() ? markdown(body) : h('p', { class: 'muted empty-body' }, t('pr.noDescription')));
}

function composer() {
  const { busy } = pullView.state;
  const area = h('textarea', { class: 'pull-reply', placeholder: t('pr.commentPlaceholder'), spellcheck: 'true', disabled: busy === 'comment' });
  area.value = pullView.draft;
  const send = h('button', { type: 'button', class: 'btn primary', disabled: Boolean(busy) || !area.value.trim(), onclick: () => pullView.comment() },
    busy === 'comment' ? t('pr.sending') : t('pr.comment'));
  area.addEventListener('input', () => {
    pullView.setDraft(area.value);
    send.disabled = Boolean(pullView.state.busy) || !area.value.trim();
  });
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      pullView.comment();
    }
  });
  return h('div', { class: 'pull-composer' }, area, h('div', { class: 'pull-composer-foot' }, h('span', { class: 'hint' }, 'Ctrl+Enter'), send));
}

function conversation(view) {
  const { details, comments } = view;
  return [
    post({ author: details.author, created: details.created, body: details.body }, true),
    comments.map((c) => post(c)),
    composer(),
  ];
}

function note(text, kind = '') {
  return h('div', { class: `pull-note ${kind}` }, text);
}

function stats(f) {
  return h('span', { class: 'stats' },
    f.binary ? t('diff.binaryShort')
      : f.additions + f.deletions === 0 && ['renamed', 'copied'].includes(f.status) ? t('diff.movedShort')
        : [h('span', { class: 'add' }, `+${f.additions}`), ' ', h('span', { class: 'del' }, `−${f.deletions}`)]);
}

/** The key of the diff a file of the changes shown opens, to mark the open one. */
function fileKey(file) {
  const { commit, changes } = pullView.state;
  return commit
    ? diffKey({ kind: 'commit', oid: commit, file: file.path })
    : diffKey({ kind: 'range', base: changes.data.base, oid: changes.data.head, file: file.path });
}

function changesTab() {
  const { changes, commit, commitDetails } = pullView.state;
  if (!changes || changes.loading) return note(t('pr.readingChanges'));
  if (changes.error) return note(describeError(changes.error), 'error');
  const { commits, files: all } = changes.data;
  const picker = h('select', {
    class: 'pull-commit-pick',
    onchange: (event) => pullView.showCommit(event.target.value || null),
  },
  h('option', { value: '' }, tn('pr.allChanges', commits.length)),
  commits.map((c) => h('option', { value: c.oid }, `${c.oid.slice(0, 7)}  ${c.summary}`)));
  picker.value = commit ?? '';
  const files = commit ? commitDetails?.files : all;
  const open = diffKey(repoStore.state.diff);
  return [
    h('div', { class: 'pull-changes-head' },
      picker,
      commit && h('button', { type: 'button', class: 'btn small', onclick: () => pullView.showCommit(null) }, t('pr.allChangesShort')),
      files && h('span', { class: 'muted' }, tn('details.files', files.length))),
    !files ? note(t('repo.loading'))
      : files.length === 0 ? note(t('pr.noChanges'))
        : h('div', { class: 'pull-files' }, files.map((f) => fileRow({
          path: f.path,
          kind: f.status,
          key: fileKey(f),
          open: open === fileKey(f),
          onclick: () => pullView.openFile(f),
          extra: stats(f),
        }))),
  ];
}

function commitsTab() {
  const { changes } = pullView.state;
  if (!changes || changes.loading) return note(t('pr.readingChanges'));
  if (changes.error) return note(describeError(changes.error), 'error');
  return h('div', { class: 'pull-commits' }, changes.data.commits.map((c) => h('div', {
    class: 'pull-commit',
    title: t('pr.commitHint'),
    onclick: () => pullView.showCommit(c.oid),
  },
  h('span', { class: 'oid' }, c.oid.slice(0, 7)),
  h('span', { class: 'summary' }, c.summary),
  h('span', { class: 'muted' }, c.author),
  when(c.time))));
}

/** Draws the pull request; the scroll position is kept while the same tab is shown. */
export function renderPull(container) {
  const { number, view, error, tab } = pullView.state;
  const shown = `${number}:${tab}`;
  const scroll = container.dataset.shown === shown ? container.querySelector('.pull-body')?.scrollTop ?? 0 : 0;
  container.dataset.shown = shown;
  if (!view) {
    mount(container, h('div', { class: 'pull-head' },
      h('div', { class: 'pull-top' },
        h('button', { type: 'button', class: 'btn pull-back', onclick: () => pullView.close() }, icon('chevron', 14, 2.2), t('pr.back')),
        h('h2', { class: 'pull-title' }, h('span', { class: 'pull-number' }, `#${number}`)))),
    error ? note(describeError(error), 'error') : note(t('repo.loading')));
    return;
  }
  mount(container,
    head(view.details),
    tabs(view.details),
    h('div', { class: `pull-body ${tab}` },
      tab === 'conversation' ? conversation(view) : tab === 'changes' ? changesTab() : commitsTab()));
  const body = container.querySelector('.pull-body');
  if (body) body.scrollTop = scroll;
}

/** Opening another file only moves the highlight. */
export function markPullFile(container) {
  const key = diffKey(repoStore.state.diff);
  for (const row of container.querySelectorAll('.frow[data-key]')) row.classList.toggle('open', row.dataset.key === key);
}

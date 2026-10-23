// One repository: branch and upstream, operation in progress, last commit, and the files of the
// working copy grouped by what has to be done with them.

import { repoBadges } from '../../components/badges.js';
import { avatar } from '../../components/tabbar.js';
import { describeError } from '../../app/errors.js';
import { t, tn } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { fullDate, relativeTime } from '../../lib/time.js';
import { store } from '../../state/store.js';

/** Letter shown for each kind of change, as in `git status --short`. */
const LETTERS = {
  modified: 'M', typeChanged: 'T', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: '?', conflicted: '!',
};

const GROUPS = [
  { key: 'conflicts', test: (f) => f.index === 'conflicted', kind: (f) => f.index },
  { key: 'staged', test: (f) => !['unmodified', 'untracked', 'ignored', 'conflicted'].includes(f.index), kind: (f) => f.index },
  { key: 'unstaged', test: (f) => ['modified', 'typeChanged', 'deleted'].includes(f.worktree), kind: (f) => f.worktree },
  { key: 'untracked', test: (f) => f.worktree === 'untracked', kind: (f) => f.worktree },
];

function fileRow(file, kind) {
  return h('div', { class: 'file' },
    h('span', { class: `kind ${kind}`, title: t(`change.${kind}`) }, LETTERS[kind] ?? '·'),
    h('span', { class: 'path', title: file.path },
      file.origPath && h('span', { class: 'from' }, `${file.origPath} → `),
      file.path));
}

function changesPanel(s) {
  const head = h('div', { class: 'changes-head' },
    h('h3', {}, t('repo.workingCopy')),
    h('span', { class: 'hint' }, s.fileCount ? tn('badge.changes', s.fileCount) : ''));
  if (!s.fileCount) {
    return h('section', { class: 'panel changes' }, head,
      h('div', { class: 'clean-state' }, icon('check', 28), t('repo.clean')));
  }
  const groups = GROUPS.map((group) => {
    const files = s.files.filter(group.test);
    if (!files.length) return null;
    return [
      h('div', { class: 'group-title section-title' }, `${t(`repo.groups.${group.key}`)} · ${files.length}`),
      h('div', {}, files.map((f) => fileRow(f, group.kind(f)))),
    ];
  });
  return h('section', { class: 'panel changes' }, head, groups,
    s.files.length < s.fileCount && h('div', { class: 'truncated hint' }, t('repo.truncated', { shown: s.files.length, total: s.fileCount })));
}

function facts(s) {
  const rows = [
    [t('repo.upstream'), s.upstream ?? t('repo.none')],
    [t('repo.remotes'), s.remotes.length ? s.remotes.join(', ') : t('repo.none')],
    [t('repo.lastCommit'), s.lastCommit
      ? h('span', { title: fullDate(s.lastCommit.time) },
        h('span', { class: 'mono' }, s.lastCommit.oid.slice(0, 7)), ` ${s.lastCommit.summary} · ${s.lastCommit.author} · ${relativeTime(s.lastCommit.time)}`)
      : t('repo.noCommit')],
  ];
  return h('dl', { class: 'repo-facts' }, rows.map(([term, value]) => [h('dt', {}, term), h('dd', {}, value)]));
}

export function renderRepo(container, repo) {
  const s = repo.summary;
  const header = h('section', { class: 'panel repo-head' },
    h('div', { class: 'repo-title' },
      avatar(repo.name, 'avatar large'),
      h('div', { class: 'names' }, h('h2', {}, repo.name), h('span', { class: 'path', title: repo.path }, repo.path)),
      h('button', { type: 'button', class: 'btn', onclick: () => store.openFolder(repo.path) }, icon('folder', 15), t('action.repo.openFolder')),
      h('button', { type: 'button', class: 'btn', onclick: () => store.refresh(repo.path) }, icon('refresh', 15), t('action.repo.refresh'))),
    h('div', { class: 'badges' }, repoBadges(repo)),
    s?.operation && h('div', { class: 'op-banner' }, icon('warning', 18), t(`repo.inProgress.${s.operation}`)),
    s && facts(s),
  );
  if (repo.error) {
    mount(container, h('div', { class: 'repo' }, header,
      h('section', { class: 'panel repo-error' },
        h('div', {}, describeError(repo.error)),
        h('button', { type: 'button', class: 'btn', onclick: () => store.remove(repo.path) }, icon('close', 15), t('action.repo.remove')))));
    return;
  }
  mount(container, h('div', { class: 'repo' }, header, s && changesPanel(s)));
}

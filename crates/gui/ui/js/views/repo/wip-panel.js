// Working copy: files to stage and staged files, each opening its diff, then the commit message.
// With nothing staged, the commit button stages everything: the common case takes one click.

import { t, tn } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { repoStore } from '../../state/repo-store.js';
import { store } from '../../state/store.js';
import { diffKey, fileRow } from './files.js';

/** Length git tools recommend for the first line of a message. */
const SUMMARY_LIMIT = 72;

const isStaged = (f) => !['unmodified', 'untracked', 'ignored', 'conflicted'].includes(f.index);
const isUnstaged = (f) => ['modified', 'typeChanged', 'deleted', 'untracked'].includes(f.worktree);
const isConflict = (f) => f.index === 'conflicted';

function openDiff(file, staged) {
  return () => repoStore.openWorktreeDiff(file.path, staged, file.worktree === 'untracked');
}

const keyOf = (file, staged) => diffKey({ kind: 'worktree', staged, file: file.path });

function isOpen(file, staged) {
  return diffKey(repoStore.state.diff) === keyOf(file, staged);
}

function action(iconName, title, run) {
  return h('button', { type: 'button', class: 'icon-btn', title, onclick: (event) => { event.stopPropagation(); run(); } }, icon(iconName, 14, 2));
}

function group(title, files, button, row) {
  if (!files.length) return null;
  return [
    h('div', { class: 'fgroup-head' }, h('span', { class: 'section-title' }, `${title} · ${files.length}`), button),
    files.map(row),
  ];
}

/** Message fields, kept between renders so that typing is never interrupted. */
const fields = { path: null, summary: null, body: null, amend: null, amendLabel: null, counter: null, button: null };

/** Builds the commit box of a repository; typing updates the draft and the button at once. */
function commitBox(repo) {
  const onKey = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) repoStore.commit(); };
  const current = () => store.activeRepo ?? repo;
  fields.path = repo.path;
  fields.summary = h('input', {
    type: 'text',
    spellcheck: 'true',
    oninput: (e) => { repoStore.setDraft({ summary: e.target.value }); updateCommitBox(current()); },
    onkeydown: onKey,
  });
  fields.body = h('textarea', { spellcheck: 'true', oninput: (e) => repoStore.setDraft({ body: e.target.value }), onkeydown: onKey });
  fields.amend = h('input', { type: 'checkbox', onchange: (e) => repoStore.setAmend(e.target.checked) });
  fields.amendLabel = h('span', {});
  fields.counter = h('span', { class: 'counter' });
  fields.button = h('button', { type: 'button', class: 'btn primary', onclick: () => repoStore.commit() });
  const el = h('div', { class: 'commit-box' },
    h('div', { class: 'summary-wrap' }, fields.summary, fields.counter),
    fields.body,
    h('div', { class: 'row' }, h('label', { class: 'check' }, fields.amend, fields.amendLabel)),
    h('div', { class: 'row' }, fields.button));
  refreshCommitBox(repo);
  return el;
}

/** Puts the draft and the texts of the current language in the commit box. */
function refreshCommitBox(repo) {
  const draft = repoStore.draft;
  if (document.activeElement !== fields.summary) fields.summary.value = draft.summary;
  if (document.activeElement !== fields.body) fields.body.value = draft.body;
  fields.amend.checked = draft.amend;
  fields.amend.disabled = !repo.summary?.lastCommit;
  fields.amendLabel.textContent = t('commit.amend');
  fields.amendLabel.parentElement.title = t('commit.amendHint');
  fields.summary.placeholder = t('commit.summary');
  fields.body.placeholder = t('commit.body');
  updateCommitBox(repo);
}

/** Counter and button follow the typing without a full render. */
function updateCommitBox(repo) {
  const s = repo.summary;
  const draft = repoStore.draft;
  const length = draft.summary.trim().length;
  fields.counter.textContent = String(SUMMARY_LIMIT - length);
  fields.counter.classList.toggle('long', length > SUMMARY_LIMIT);
  const branch = s?.head.branch ?? 'HEAD';
  const stagesAll = !draft.amend && s && s.staged === 0;
  const nothing = !draft.amend && (!s || s.fileCount === 0 || (stagesAll && s.conflicted > 0));
  fields.button.replaceChildren(
    icon(repoStore.state.running === 'commit' ? 'refresh' : 'check', 16, 2),
    draft.amend ? t('commit.amendButton') : stagesAll ? tn('commit.stageAllButton', s?.fileCount ?? 0, { branch }) : tn('commit.button', s.staged, { branch }),
  );
  fields.button.disabled = nothing || length === 0 || Boolean(repoStore.state.running);
  fields.button.title = length === 0 ? t('commit.needSummary') : '';
}

/** The file list scrolls on its own; with the commit box, it is built once per repository. */
let scroll = null;
let box = null;

export function renderWipPanel(container, repo) {
  const s = repo.summary;
  if (!s) {
    mount(container, h('div', { class: 'loading' }, t('repo.loading')));
    return;
  }
  if (fields.path !== repo.path || !scroll) {
    scroll = h('div', { class: 'side-scroll' });
    box = commitBox(repo);
  } else {
    refreshCommitBox(repo);
  }
  // Moving the message fields in the page would take the focus away from them: they stay put.
  if (container.firstChild !== scroll || container.lastChild !== box) mount(container, scroll, box);
  const files = s.files;
  const conflicts = files.filter(isConflict);
  const unstaged = files.filter((f) => !isConflict(f) && isUnstaged(f));
  const staged = files.filter((f) => !isConflict(f) && isStaged(f));
  const list = s.fileCount === 0
    ? h('div', { class: 'clean-state' }, icon('check', 28), t('repo.clean'))
    : [
      group(t('repo.groups.conflicts'), conflicts, null, (f) => fileRow({
        path: f.path, kind: 'conflicted', key: keyOf(f, false), open: isOpen(f, false), onclick: () => repoStore.openConflict(f.path),
        actions: [action('check', t('wip.markResolved'), () => repoStore.stage([f.path]))],
      })),
      group(t('wip.unstaged'), unstaged,
        h('button', { type: 'button', class: 'btn', onclick: () => repoStore.stageAll() }, t('wip.stageAll')),
        (f) => fileRow({
          path: f.path, kind: f.worktree, key: keyOf(f, false), open: isOpen(f, false), onclick: openDiff(f, false),
          actions: [
            action('remove', t('wip.discard'), () => repoStore.discard([f])),
            action('plus', t('wip.stage'), () => repoStore.stage([f.path])),
          ],
        })),
      group(t('wip.staged'), staged,
        h('button', { type: 'button', class: 'btn', onclick: () => repoStore.unstageAll() }, t('wip.unstageAll')),
        (f) => fileRow({
          path: f.path, kind: f.index, key: keyOf(f, true), open: isOpen(f, true), onclick: openDiff(f, true),
          actions: [action('minus', t('wip.unstage'), () => repoStore.unstage([f.path]))],
        })),
      s.files.length < s.fileCount && h('div', { class: 'truncated hint' }, t('repo.truncated', { shown: s.files.length, total: s.fileCount })),
    ];
  mount(scroll,
    h('div', { class: 'side-head' }, h('h3', {}, t('repo.workingCopy')), s.fileCount > 0 && h('span', { class: 'hint' }, tn('badge.changes', s.fileCount))),
    list);
}

/** Only the commit button depends on the long command in progress. */
export function updateWipRunning(repo) {
  if (fields.path === repo.path && fields.button) updateCommitBox(repo);
}

// Opening a pull request on the service of the repository shown: from a local branch (the current
// one by default) to a branch of the remote on that service, with a title and a description. The
// current branch is pushed first when the service does not have all its commits yet.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { pullView } from '../state/pull-view.js';
import { pulls } from '../state/pulls.js';
import { repoStore } from '../state/repo-store.js';
import { store } from '../state/store.js';
import { dialogHead, openDialog } from './dialog.js';

/** Usual names of the main branch, in the order they are preferred as the target. */
const MAIN_BRANCHES = ['main', 'master', 'develop', 'trunk'];

/** The branch as the service knows it: the name of its upstream on `remote`, or its own name. */
function remoteName(branch, remote) {
  const prefix = `${remote}/`;
  return branch.upstream?.startsWith(prefix) ? branch.upstream.slice(prefix.length) : branch.name;
}

/** What the branch needs before a pull request: null, 'push' (the current one) or 'other' (to push from it). */
function pushNeeded(branch, remote) {
  const pushed = branch.upstream?.startsWith(`${remote}/`) && !branch.gone && !branch.ahead;
  if (pushed) return null;
  return branch.isHead ? 'push' : 'other';
}

/** `path`: the repository shown. Resolves when the dialog is closed. */
export function openNewPullDialog(path) {
  const refs = repoStore.state.refs;
  const hosting = pulls.of(path)?.hosting;
  if (!refs || repoStore.state.path !== path) return Promise.resolve(null);
  if (!hosting) {
    store.notify(describeError({ code: 'no_hosting' }), true);
    return Promise.resolve(null);
  }
  const remote = hosting.remote;
  const local = [...refs.local].sort((a, b) => Number(b.isHead) - Number(a.isHead) || a.name.localeCompare(b.name));
  const targets = refs.remote
    .filter((b) => b.name.startsWith(`${remote}/`) && b.name !== `${remote}/HEAD`)
    .map((b) => b.name.slice(remote.length + 1))
    .sort((a, b) => a.localeCompare(b));
  if (!local.length || !targets.length) {
    store.notify(t('newPr.noBranches', { remote }), true);
    return Promise.resolve(null);
  }

  let busy = false;
  return openDialog((box, close) => {
    box.classList.add('medium', 'new-pull');
    const source = h('select', { class: 'select', 'aria-label': t('newPr.source') }, local.map((b) => h('option', { value: b.name }, b.name)));
    const target = h('select', { class: 'select', 'aria-label': t('newPr.target') }, targets.map((name) => h('option', { value: name }, name)));
    const title = h('input', { type: 'text', spellcheck: 'true', autofocus: true });
    const body = h('textarea', { class: 'edit-area', spellcheck: 'true', placeholder: t('newPr.bodyPlaceholder') });
    const draft = h('input', { type: 'checkbox' });
    const note = h('div', { class: 'new-pull-note' });
    const error = h('div', { class: 'field-error' });
    const create = h('button', { type: 'button', class: 'btn primary' });
    const cancel = h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.cancel'));

    const branch = () => local.find((b) => b.name === source.value);
    /** The title follows the last commit of the branch until the user writes one. */
    let titleEdited = false;
    title.addEventListener('input', () => { titleEdited = true; error.textContent = ''; });

    const update = () => {
      const b = branch();
      if (!titleEdited) title.value = b.summary ?? '';
      const need = pushNeeded(b, remote);
      const sameBranch = remoteName(b, remote) === target.value;
      mount(note,
        need === 'push' && [icon('push', 14), h('span', {}, t('newPr.willPush', { branch: b.name, remote }))],
        need === 'other' && [icon('warning', 14), h('span', {}, t('newPr.pushOther', { branch: b.name, remote }))],
        sameBranch && [icon('warning', 14), h('span', {}, t('newPr.sameBranch'))]);
      note.className = `new-pull-note${need === 'other' || sameBranch ? ' warn' : need ? ' info' : ''}`;
      create.disabled = busy || need === 'other' || sameBranch;
      mount(create, busy ? t('newPr.creating') : need === 'push' ? t('newPr.pushAndCreate') : t('newPr.create'));
    };

    const submit = async () => {
      if (create.disabled) return;
      if (!title.value.trim()) {
        error.textContent = t('errors.title_missing');
        title.focus();
        return;
      }
      busy = true;
      cancel.disabled = true;
      update();
      const b = branch();
      try {
        if (pushNeeded(b, remote) === 'push') {
          await repoStore.push();
          const after = store.repositories.find((r) => r.path === path)?.summary;
          if (!after?.upstream || after.ahead > 0) throw null;
        }
        const created = await backend.createPullRequest(path, {
          sourceBranch: remoteName(b, remote),
          targetBranch: target.value,
          title: title.value.trim(),
          body: body.value,
          draft: draft.checked,
        });
        close(created);
        store.notify(t('newPr.created', { number: created.number }));
        pulls.reload(path);
        pullView.open(path, created.number);
      } catch (problem) {
        // A failed push was already shown; the dialog stays open to try again.
        error.textContent = problem ? describeError(problem) : '';
        busy = false;
        cancel.disabled = false;
        update();
      }
    };
    create.addEventListener('click', submit);
    body.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit();
      }
    });
    title.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
    source.addEventListener('change', update);
    target.addEventListener('change', update);

    const head = local.find((b) => b.isHead) ?? local[0];
    source.value = head.name;
    const main = MAIN_BRANCHES.find((name) => targets.includes(name) && name !== remoteName(head, remote));
    target.value = main ?? targets.find((name) => name !== remoteName(head, remote)) ?? targets[0];
    update();

    mount(box,
      dialogHead(t('newPr.title'), close),
      h('div', { class: 'new-pull-branches' },
        h('label', { class: 'field' }, h('span', { class: 'label' }, t('newPr.source')), source),
        h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
        h('label', { class: 'field' }, h('span', { class: 'label' }, t('newPr.target', { remote })), target)),
      note,
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('newPr.titleField')), title),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('newPr.body')), body),
      h('label', { class: 'check' }, draft, t('newPr.draft')),
      error,
      h('div', { class: 'dialog-foot' }, h('span', { class: 'hint' }, 'Ctrl+Enter'), cancel, create));
    setTimeout(() => title.select(), 0);
  }, () => !busy);
}

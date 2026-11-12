// Creating a worktree: a new branch (from the current one, or any branch) or an existing branch
// that no worktree has checked out yet, and the folder it goes into, next to the repository by
// default. The tab can show it at once.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { dialogHead, openDialog } from './dialog.js';

function parentOf(path) {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut > 0 ? path.slice(0, cut) : path;
}

function nameOf(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function join(folder, name) {
  const separator = folder.includes('\\') ? '\\' : '/';
  return folder.replace(/[\\/]+$/, '') + separator + name;
}

/** « feature/login » → « depot-feature-login », next to the repository. */
function defaultFolder(repoPath, branch) {
  const slug = branch.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? join(parentOf(repoPath), `${nameOf(repoPath)}-${slug}`) : '';
}

/**
 * Asks for the worktree and creates it; resolves with the snapshot, or null. `refs`: the branches of
 * the repository; `main`: its main folder, next to which the worktree goes by default; `preset`: { branch } to start from an existing local branch, { start } to start a
 * new branch from a commit or a remote branch.
 */
export function openWorktreeDialog({ path, main = path, refs, preset = {} }) {
  const free = refs.local.filter((b) => !b.isHead && !b.worktree).map((b) => b.name).sort((a, b) => a.localeCompare(b));
  const head = refs.local.find((b) => b.isHead)?.name ?? 'HEAD';
  let busy = false;
  return openDialog((box, close) => {
    box.classList.add('medium', 'worktree-dialog');
    const modeNew = h('input', { type: 'radio', name: 'wt-mode', checked: !preset.branch || !free.includes(preset.branch) });
    const modeExisting = h('input', { type: 'radio', name: 'wt-mode', checked: Boolean(preset.branch && free.includes(preset.branch)), disabled: free.length === 0 });
    const remoteName = preset.start && refs.remote.some((b) => b.name === preset.start) ? preset.start.split('/').slice(1).join('/') : '';
    const name = h('input', { type: 'text', spellcheck: 'false', placeholder: 'feature/my-change', value: remoteName });
    const startChoices = [...new Set([preset.start, head, ...refs.local.map((b) => b.name), ...refs.remote.map((b) => b.name)].filter(Boolean))];
    const start = h('select', { class: 'select' }, startChoices.map((s) => h('option', { value: s }, s)));
    start.value = preset.start ?? head;
    const existing = h('select', { class: 'select' }, free.map((b) => h('option', { value: b }, b)));
    if (preset.branch && free.includes(preset.branch)) existing.value = preset.branch;
    const folder = h('input', { type: 'text', spellcheck: 'false' });
    const show = h('input', { type: 'checkbox', checked: true });
    const error = h('div', { class: 'field-error' });
    const submit = h('button', { type: 'button', class: 'btn primary' }, icon('plus', 15), t('wt.create'));
    const newFields = h('div', { class: 'wt-fields' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('wt.branchName')), name),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('wt.start')), start));
    const existingFields = h('div', { class: 'wt-fields' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('wt.branch')), existing));
    let folderEdited = false;

    const branchName = () => (modeNew.checked ? name.value.trim().replace(/\s+/g, '-') : existing.value);
    const update = () => {
      newFields.hidden = !modeNew.checked;
      existingFields.hidden = modeNew.checked;
      if (!folderEdited) folder.value = defaultFolder(main, branchName());
      submit.disabled = busy || !branchName() || !folder.value.trim();
      error.textContent = '';
    };
    for (const el of [modeNew, modeExisting, existing, start]) el.addEventListener('change', update);
    name.addEventListener('input', update);
    folder.addEventListener('input', () => { folderEdited = folder.value.trim() !== ''; update(); });

    const browse = async () => {
      const chosen = await backend.pickCloneFolder(parentOf(folder.value.trim() || main));
      if (!chosen) return;
      folder.value = join(chosen, nameOf(defaultFolder(main, branchName()) || 'worktree'));
      folderEdited = true;
      update();
    };

    const run = async () => {
      if (submit.disabled) return;
      const target = modeNew.checked ? { kind: 'new', branch: branchName(), start: start.value } : { kind: 'existing', branch: branchName() };
      busy = true;
      update();
      try {
        close(await backend.addWorktree(path, folder.value.trim(), target, show.checked));
      } catch (failure) {
        busy = false;
        update();
        error.textContent = describeError(failure);
      }
    };
    submit.addEventListener('click', run);
    for (const input of [name, folder]) input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });

    mount(box,
      dialogHead(t('wt.newTitle'), close),
      h('div', { class: 'wt-modes' },
        h('label', { class: 'check' }, modeNew, t('wt.modeNew')),
        h('label', { class: 'check', title: free.length ? '' : t('wt.noFreeBranch') }, modeExisting, t('wt.modeExisting'))),
      newFields,
      existingFields,
      h('div', { class: 'field' },
        h('span', { class: 'label' }, t('wt.folder')),
        h('div', { class: 'with-button' }, folder,
          h('button', { type: 'button', class: 'btn browse', onclick: browse }, icon('folder', 15), t('clone.browse')))),
      h('label', { class: 'check' }, show, t('wt.showHere')),
      error,
      h('div', { class: 'dialog-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.cancel')),
        submit));
    update();
    setTimeout(() => (modeNew.checked ? name : existing).focus(), 0);
  });
}

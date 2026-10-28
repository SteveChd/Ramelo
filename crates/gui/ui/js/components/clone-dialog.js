// Cloning a repository: its address, the folder it goes into and its name there, and optionally a
// branch and the submodules. Git's progress shows while it runs, and the clone can be stopped.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openDialog } from './dialog.js';

const FOLDER_KEY = 'ramelo.cloneFolder';

/** The folder name a clone of `url` gets by default: its last part, without « .git ». */
export function cloneName(url) {
  const trimmed = url.trim().replace(/[\\/]+$/, '');
  const last = trimmed.split(/[\\/:]/).pop() ?? '';
  return last.replace(/\.git$/, '');
}

function join(folder, name) {
  const separator = folder.includes('\\') ? '\\' : '/';
  return folder.replace(/[\\/]+$/, '') + separator + name;
}

function lastFolder(fallback) {
  try {
    return localStorage.getItem(FOLDER_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

function rememberFolder(folder) {
  try {
    localStorage.setItem(FOLDER_KEY, folder);
  } catch {
    // Not remembered: the field starts empty next time.
  }
}

/** The parent folder of `path` (the folder a repository already in the workspace sits in). */
function parentOf(path) {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut > 0 ? path.slice(0, cut) : '';
}

/**
 * Asks for the clone and runs it; resolves with the path of the new repository, or null.
 * `near`: a repository path whose folder is offered when no folder was used before.
 */
export function openCloneDialog({ near = null } = {}) {
  let running = false;
  return openDialog((box, close) => {
    box.classList.add('medium', 'clone-dialog');
    const url = h('input', { type: 'text', autofocus: true, spellcheck: 'false', placeholder: t('clone.urlPlaceholder') });
    const folder = h('input', { type: 'text', spellcheck: 'false', value: lastFolder(near ? parentOf(near) : ''), placeholder: t('clone.folderPlaceholder') });
    const name = h('input', { type: 'text', spellcheck: 'false' });
    const branch = h('input', { type: 'text', spellcheck: 'false', placeholder: t('clone.branchPlaceholder') });
    const submodules = h('input', { type: 'checkbox' });
    const target = h('div', { class: 'clone-target' });
    const error = h('div', { class: 'field-error' });
    const phase = h('span', { class: 'phase' });
    const detail = h('span', { class: 'detail' });
    const bar = h('div', { class: 'bar' });
    const progress = h('div', { class: 'clone-progress', hidden: true },
      h('div', { class: 'line' }, phase, detail),
      h('div', { class: 'track' }, bar));
    const cancel = h('button', { type: 'button', class: 'btn' }, t('dialog.cancel'));
    const submit = h('button', { type: 'button', class: 'btn primary' }, icon('fetch', 15), t('clone.confirm'));
    let nameEdited = false;

    const update = () => {
      if (!nameEdited) name.value = cloneName(url.value);
      const ready = url.value.trim() && folder.value.trim() && name.value.trim();
      target.textContent = ready ? t('clone.into', { path: join(folder.value.trim(), name.value.trim()) }) : '';
      submit.disabled = !ready || running;
      error.textContent = '';
    };
    url.addEventListener('input', update);
    folder.addEventListener('input', update);
    name.addEventListener('input', () => { nameEdited = name.value.trim() !== ''; update(); });

    const browse = async () => {
      const chosen = await backend.pickCloneFolder(folder.value.trim() || null);
      if (chosen) {
        folder.value = chosen;
        update();
      }
    };

    const setRunning = (value) => {
      running = value;
      for (const input of [url, folder, name, branch, submodules]) input.disabled = value;
      box.querySelector('.browse').disabled = value;
      progress.hidden = !value;
      cancel.textContent = value ? t('clone.stop') : t('dialog.cancel');
      update();
    };

    const run = async () => {
      if (submit.disabled) return;
      const path = join(folder.value.trim(), name.value.trim());
      phase.textContent = t('clone.starting');
      detail.textContent = '';
      bar.style.width = '0%';
      bar.classList.add('busy');
      setRunning(true);
      try {
        const options = { branch: branch.value.trim() || null, submodules: submodules.checked };
        const result = await backend.cloneRepository(url.value.trim(), path, options, (p) => {
          phase.textContent = t(`clone.phase.${p.phase}`) === `clone.phase.${p.phase}` ? p.phase : t(`clone.phase.${p.phase}`);
          detail.textContent = p.percent === null ? '' : `${p.percent} %`;
          bar.classList.toggle('busy', p.percent === null);
          if (p.percent !== null) bar.style.width = `${p.percent}%`;
        });
        rememberFolder(folder.value.trim());
        running = false;
        close(result);
      } catch (failure) {
        setRunning(false);
        if (failure?.code !== 'cancelled') error.textContent = describeError(failure);
      }
    };

    submit.addEventListener('click', run);
    cancel.addEventListener('click', () => (running ? backend.cancelClone() : close(null)));
    for (const input of [url, folder, name, branch]) {
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });
    }

    mount(box,
      h('div', { class: 'dialog-head' },
        h('h2', {}, t('clone.title')),
        h('button', { type: 'button', class: 'icon-btn', title: t('dialog.cancel'), onclick: () => (running ? backend.cancelClone() : close(null)) }, icon('close', 16))),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('clone.url')), url),
      h('div', { class: 'field' },
        h('span', { class: 'label' }, t('clone.folder')),
        h('div', { class: 'with-button' }, folder,
          h('button', { type: 'button', class: 'btn browse', onclick: browse }, icon('folder', 15), t('clone.browse')))),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('clone.name')), name),
      h('details', { class: 'clone-options' },
        h('summary', {}, t('clone.options')),
        h('label', { class: 'field' }, h('span', { class: 'label' }, t('clone.branch')), branch),
        h('label', { class: 'check' }, submodules, t('clone.submodules'))),
      target,
      progress,
      error,
      h('div', { class: 'dialog-foot' }, cancel, submit));
    update();
  }, () => {
    // Escape or a click outside while cloning stops the clone instead of hiding it.
    if (running) backend.cancelClone();
    return !running;
  });
}

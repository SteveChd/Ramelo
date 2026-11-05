// Cloning a repository: its address, the folder it goes into and its name there, and optionally a
// branch and the submodules. Git's progress shows while it runs, and the clone can be stopped.
// Several repositories can also be cloned together into one folder, one after the other.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { t, tn } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openDialog } from './dialog.js';
import { withHostTrust } from './host-trust.js';

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
 * `near`: a repository path whose folder is offered when no folder was used before; `address`: the
 * address to clone, when it was chosen elsewhere (a repository found on an account). `find`: called
 * by the link that searches the accounts instead, after this dialog is closed.
 */
export function openCloneDialog({ near = null, address = '', find = null } = {}) {
  let running = false;
  return openDialog((box, close) => {
    box.classList.add('medium', 'clone-dialog');
    const url = h('input', { type: 'text', autofocus: !address, spellcheck: 'false', value: address, placeholder: t('clone.urlPlaceholder') });
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
        const result = await withHostTrust(() => backend.cloneRepository(url.value.trim(), path, options, (p) => {
          phase.textContent = t(`clone.phase.${p.phase}`) === `clone.phase.${p.phase}` ? p.phase : t(`clone.phase.${p.phase}`);
          detail.textContent = p.percent === null ? '' : `${p.percent} %`;
          bar.classList.toggle('busy', p.percent === null);
          if (p.percent !== null) bar.style.width = `${p.percent}%`;
        }));
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
      h('label', { class: 'field' },
        h('span', { class: 'label' }, t('clone.url')),
        url,
        find && h('button', { type: 'button', class: 'link find-link', onclick: () => { if (!running) { close(null); find(); } } }, icon('search', 13), t('finder.fromClone'))),
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
    // An address chosen elsewhere: the folder is what is left to check.
    if (address) setTimeout(() => submit.focus(), 0);
  }, () => {
    // Escape or a click outside while cloning stops the clone instead of hiding it.
    if (running) backend.cancelClone();
    return !running;
  });
}

/** The name git gives a phase of its progress, translated when it is known. */
function phaseName(phase) {
  const key = `clone.phase.${phase}`;
  return t(key) === key ? phase : t(key);
}

/**
 * Asks where to clone `addresses` and clones them one after the other; resolves with the paths of
 * those cloned (possibly none). One that fails does not stop the others: its error shows on its
 * line, and « Clone » tries again those not cloned yet.
 */
export function openCloneManyDialog({ near = null, addresses }) {
  let running = false;
  let stopped = false;
  const items = addresses.map((address) => ({ address, name: cloneName(address), status: 'waiting', error: '', phase: '', percent: null }));
  const cloned = [];
  return openDialog((box, close) => {
    box.classList.add('medium', 'clone-dialog', 'clone-many');
    const folder = h('input', { type: 'text', spellcheck: 'false', value: lastFolder(near ? parentOf(near) : ''), placeholder: t('clone.folderPlaceholder') });
    const submodules = h('input', { type: 'checkbox' });
    const list = h('div', { class: 'clone-list' });
    const error = h('div', { class: 'field-error' });
    const cancel = h('button', { type: 'button', class: 'btn' }, t('dialog.cancel'));
    const submit = h('button', { type: 'button', class: 'btn primary' }, icon('fetch', 15), t('clone.confirm'));
    const browseButton = h('button', { type: 'button', class: 'btn browse' }, icon('folder', 15), t('clone.browse'));

    const left = () => items.filter((item) => item.status !== 'done');
    const finish = () => close(cloned);

    /** Two repositories cannot go into the same folder. */
    const clash = () => {
      const names = left().map((item) => item.name.trim().toLowerCase());
      return names.some((name, i) => names.indexOf(name) !== i);
    };

    const line = (item) => {
      const name = h('input', { type: 'text', spellcheck: 'false', value: item.name, disabled: running || item.status === 'done', 'aria-label': t('clone.name') });
      name.addEventListener('input', () => {
        item.name = name.value;
        update();
      });
      let state;
      if (item.status === 'running') {
        state = h('div', { class: 'clone-progress' },
          h('div', { class: 'line' }, h('span', { class: 'phase' }, item.phase || t('clone.starting')), h('span', { class: 'detail' }, item.percent === null ? '' : `${item.percent} %`)),
          h('div', { class: 'track' }, h('div', { class: `bar${item.percent === null ? ' busy' : ''}`, style: item.percent === null ? '' : `width: ${item.percent}%` })));
      } else if (item.status === 'done') {
        state = h('span', { class: 'clone-state done' }, icon('check', 13), t('clone.itemDone'));
      } else if (item.status === 'failed') {
        state = h('span', { class: 'clone-state failed', title: item.error }, item.error);
      } else {
        state = h('span', { class: 'clone-state' }, t('clone.itemWaiting'));
      }
      return h('div', { class: `clone-item ${item.status}` },
        h('div', { class: 'clone-item-head' },
          name,
          !running && item.status !== 'done' && h('button', {
            type: 'button',
            class: 'icon-btn',
            title: t('clone.leaveOut'),
            onclick: () => {
              items.splice(items.indexOf(item), 1);
              if (items.length === 0) finish();
              else draw();
            },
          }, icon('close', 13))),
        h('div', { class: 'clone-item-address' }, item.address),
        state);
    };

    const update = () => {
      const ready = folder.value.trim() && left().length > 0 && left().every((item) => item.name.trim()) && !clash();
      submit.disabled = !ready || running;
      submit.lastChild.textContent = tn('clone.confirmMany', left().length);
      error.textContent = clash() ? t('clone.sameName') : '';
    };

    const draw = () => {
      mount(list, items.map(line));
      folder.disabled = running;
      submodules.disabled = running;
      browseButton.disabled = running;
      cancel.textContent = running ? t('clone.stop') : cloned.length ? t('dialog.close') : t('dialog.cancel');
      update();
    };

    browseButton.addEventListener('click', async () => {
      const chosen = await backend.pickCloneFolder(folder.value.trim() || null);
      if (chosen) {
        folder.value = chosen;
        update();
      }
    });
    folder.addEventListener('input', update);

    const run = async () => {
      if (submit.disabled) return;
      running = true;
      stopped = false;
      const base = folder.value.trim();
      for (const item of left()) item.status = 'waiting';
      draw();
      for (const item of left()) {
        if (stopped) break;
        item.status = 'running';
        item.phase = '';
        item.percent = null;
        draw();
        try {
          const path = await withHostTrust(() => backend.cloneRepository(item.address, join(base, item.name.trim()), { branch: null, submodules: submodules.checked }, (p) => {
            item.phase = phaseName(p.phase);
            item.percent = p.percent;
            const shown = list.children[items.indexOf(item)];
            if (shown) shown.replaceWith(line(item));
          }));
          item.status = 'done';
          cloned.push(path);
          rememberFolder(base);
        } catch (failure) {
          item.status = failure?.code === 'cancelled' ? 'waiting' : 'failed';
          item.error = failure?.code === 'cancelled' ? '' : describeError(failure);
        }
        draw();
      }
      running = false;
      if (left().length === 0) finish();
      else draw();
    };

    submit.addEventListener('click', run);
    cancel.addEventListener('click', () => {
      if (running) {
        stopped = true;
        backend.cancelClone();
      } else {
        finish();
      }
    });

    mount(box,
      h('div', { class: 'dialog-head' },
        h('h2', {}, tn('clone.titleMany', items.length)),
        h('button', { type: 'button', class: 'icon-btn', title: t('dialog.cancel'), onclick: () => cancel.click() }, icon('close', 16))),
      h('div', { class: 'field' },
        h('span', { class: 'label' }, t('clone.folder')),
        h('div', { class: 'with-button' }, folder, browseButton)),
      h('div', { class: 'field' },
        h('span', { class: 'label' }, t('clone.names')),
        list),
      h('label', { class: 'check' }, submodules, t('clone.submodules')),
      error,
      h('div', { class: 'dialog-foot' }, cancel, submit));
    draw();
    setTimeout(() => (folder.value.trim() ? submit.focus() : folder.focus()), 0);
  }, () => {
    // Escape or a click outside while cloning stops the clones instead of hiding them.
    if (running) {
      stopped = true;
      backend.cancelClone();
      return false;
    }
    return true;
  });
}

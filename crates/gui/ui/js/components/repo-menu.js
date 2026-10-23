// Menu of a repository (right click on its tab or its card, or its colour button): its colour, then
// the usual actions on it.

import { t } from '../i18n/i18n.js';
import { h } from '../lib/dom.js';
import { icon, repoColor } from '../lib/icons.js';
import { store } from '../state/store.js';
import { closeContextMenu, openContextMenu } from './context-menu.js';

/** Colours offered; any other one can be picked with the system colour chooser. */
export const PALETTE = [
  '#2450d8', '#0e8ad8', '#18a08a', '#2f9e44', '#7a9a12', '#d4a017',
  '#e08a1e', '#e5533d', '#d9485f', '#c2408f', '#7a4fd0', '#5b6475',
];

function choose(repo, color) {
  closeContextMenu();
  if ((repo.color ?? null) !== color) store.setColor(repo.path, color);
}

function colorPicker(repo) {
  const current = repo.color ?? null;
  const custom = h('input', {
    type: 'color',
    value: current ?? '#2450d8',
    title: t('color.custom'),
    // `change` fires once the system chooser is closed, not at each step of the drag.
    onchange: (event) => choose(repo, event.target.value),
  });
  return h('div', { class: 'color-picker' },
    h('div', { class: 'color-title' }, t('color.title')),
    h('div', { class: 'swatches' },
      PALETTE.map((color) => h('button', {
        type: 'button',
        class: `swatch${current === color ? ' on' : ''}`,
        style: { background: color },
        title: color,
        'aria-label': color,
        onclick: () => choose(repo, color),
      }, current === color && icon('check', 14, 2.4)))),
    h('div', { class: 'color-row' },
      h('button', { type: 'button', class: `btn auto${current ? '' : ' on'}`, onclick: () => choose(repo, null) },
        h('span', { class: 'swatch mini', style: { background: repoColor({ name: repo.name }) } }), t('color.auto')),
      h('label', { class: 'btn custom' }, custom, t('color.custom'))));
}

export function openRepoMenu(at, repo) {
  openContextMenu(at, [
    colorPicker(repo),
    '-',
    { label: t('action.repo.openFolder'), icon: 'folder', run: () => store.openFolder(repo.path) },
    { label: t('action.repo.refresh'), icon: 'refresh', run: () => store.refresh(repo.path) },
    '-',
    !repo.closed && { label: t('action.repo.closeTab'), icon: 'close', run: () => store.close(repo.path) },
    { label: t('action.repo.remove'), icon: 'remove', run: () => store.remove(repo.path) },
  ]);
}

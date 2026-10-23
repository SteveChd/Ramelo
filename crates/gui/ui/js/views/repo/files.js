// A file in a list: kind of change, name, folder, and the actions shown on hover.

import { t } from '../../i18n/i18n.js';
import { h } from '../../lib/dom.js';

/** Letter shown for each kind of change, as in `git status --short`. */
export const LETTERS = {
  modified: 'M', typeChanged: 'T', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!',
};

export function splitPath(path) {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { name: path, dir: '' } : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

/** `kind`: key of LETTERS; `extra`: stats or other content before the actions. */
export function fileRow({ path, kind, open = false, onclick, actions = [], extra = null }) {
  const { name, dir } = splitPath(path);
  return h('div', { class: `frow${open ? ' open' : ''}`, title: path, onclick },
    h('span', { class: `kind ${kind}`, title: t(`change.${kind}`) }, LETTERS[kind] ?? '·'),
    h('span', { class: 'name' }, name),
    h('span', { class: 'dir' }, h('bdi', {}, dir)),
    extra,
    actions.length > 0 && h('span', { class: 'acts' }, actions));
}

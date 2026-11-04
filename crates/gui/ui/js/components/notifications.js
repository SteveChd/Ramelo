// The bell of the menu bar: what is new in the watched repositories (pull requests opened, comments),
// the unread ones counted on it. A notification opens its pull request.

import { t, tn } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { relativeTime } from '../lib/time.js';
import { pullView } from '../state/pull-view.js';
import { store } from '../state/store.js';
import { watch } from '../state/watch.js';
import { closeContextMenu, openContextMenu } from './context-menu.js';

const nameOf = (path) => store.repositories.find((r) => r.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop();

async function show(note) {
  closeContextMenu();
  watch.markRead(note.id);
  if (!store.repositories.some((r) => r.path === note.path)) return;
  await store.select(note.path);
  pullView.open(note.path, note.number);
}

function panel() {
  const notes = watch.notes;
  return h('div', { class: 'notes-panel' },
    h('div', { class: 'notes-head' },
      h('span', { class: 'menu-title' }, t('watch.title')),
      h('span', { class: 'muted' }, tn('watch.watchedCount', store.repositories.filter((r) => watch.isWatched(r.path)).length)),
      notes.length > 0 && h('button', { type: 'button', class: 'link-btn', onclick: () => { watch.markAllRead(); refreshPanel(); } }, t('watch.markAllRead')),
      notes.length > 0 && h('button', { type: 'button', class: 'link-btn', onclick: () => { watch.clear(); refreshPanel(); } }, t('watch.clear'))),
    notes.length === 0
      ? h('div', { class: 'notes-empty' }, icon('bell', 22), h('p', {}, t('watch.empty')))
      : h('div', { class: 'notes-list' }, notes.map((note) => h('button', {
        type: 'button',
        class: `note${note.read ? '' : ' unread'}`,
        onclick: () => show(note),
      },
      h('span', { class: 'note-icon' }, icon(note.kind === 'pull' ? 'pullRequest' : 'comment', 14)),
      h('span', { class: 'note-body' },
        h('span', { class: 'note-where' }, h('b', {}, nameOf(note.path)), ` · #${note.number}`, h('time', {}, relativeTime(Math.floor(note.at / 1000)))),
        h('span', { class: 'note-text' }, note.text))))));
}

let menu = null;

function refreshPanel() {
  if (menu?.isConnected) mount(menu, panel());
}

function open(button) {
  menu = openContextMenu(button, [panel()]);
  menu.classList.add('notes-menu');
  // Kept inside the window, right edge under the bell.
  const rect = button.getBoundingClientRect();
  menu.style.left = `${Math.max(4, rect.right - menu.getBoundingClientRect().width)}px`;
}

let bell = null;

function update() {
  if (!bell) return;
  const unread = watch.unread;
  const badge = bell.querySelector('.bell-badge');
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.hidden = unread === 0;
  bell.title = unread ? tn('watch.unread', unread) : t('watch.title');
  refreshPanel();
}

watch.subscribe(update);

/** The bell, drawn again with the menu bar. */
export function notificationBell() {
  bell = h('button', {
    type: 'button',
    class: 'icon-btn bell',
    onclick: (event) => {
      event.stopPropagation();
      if (menu?.isConnected) closeContextMenu();
      else open(event.currentTarget);
    },
  }, icon('bell'), h('span', { class: 'bell-badge', hidden: true }));
  update();
  return bell;
}

// Tabs: the overview of all repositories, then one tab per repository. A tab is dragged to change the
// order; the middle button closes it, as in a browser.

import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { avatarColor, icon } from '../lib/icons.js';
import { store } from '../state/store.js';
import { repoState } from './badges.js';

/** Distance the pointer must travel before a click becomes a drag. */
const DRAG_THRESHOLD = 5;

export function avatar(name, className = 'avatar') {
  return h('span', { class: className, style: { background: avatarColor(name) }, 'aria-hidden': 'true' }, [...name][0] ?? '?');
}

function homeTab() {
  return h('button', {
    type: 'button',
    class: 'tab home',
    role: 'tab',
    'aria-selected': String(store.active === null),
    title: t('tabs.overviewHint'),
    onclick: () => store.select(null),
  }, icon('grid', 15), h('span', { class: 'name' }, t('tabs.overview')));
}

function repoTab(repo) {
  const state = repoState(repo);
  const tab = h('div', {
    class: 'tab',
    role: 'tab',
    tabindex: '0',
    'aria-selected': String(store.active === repo.path),
    title: repo.path,
    dataset: { path: repo.path },
    onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') store.select(repo.path); },
    onauxclick: (event) => { if (event.button === 1) store.remove(repo.path); },
  },
  avatar(repo.name),
  h('span', { class: 'name' }, repo.name),
  ['dirty', 'conflict', 'error'].includes(state) && h('span', { class: `state-dot ${state}` }),
  h('button', {
    type: 'button',
    class: 'close',
    title: t('tabs.close'),
    onpointerdown: (event) => event.stopPropagation(),
    onclick: (event) => { event.stopPropagation(); store.remove(repo.path); },
  }, icon('close', 13, 2.2)));
  installDrag(tab, repo);
  return tab;
}

/** Click selects the tab; a drag moves it among the other repository tabs. */
function installDrag(tab, repo) {
  tab.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const bar = tab.parentElement;
    const tabs = [...bar.querySelectorAll('.tab[data-path]')];
    const startX = event.clientX;
    const from = tabs.indexOf(tab);
    // Positions before the drag: the other tabs slide aside while the dragged one follows the pointer.
    const centres = tabs.map((other) => {
      const rect = other.getBoundingClientRect();
      return rect.left + rect.width / 2;
    });
    const width = tab.getBoundingClientRect().width + 2;
    let dragging = false;
    let target = from;

    const move = (e) => {
      const dx = e.clientX - startX;
      if (!dragging && Math.abs(dx) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        tab.classList.add('dragging');
        bar.classList.add('reordering');
      }
      tab.style.transform = `translateX(${dx}px)`;
      const centre = centres[from] + dx;
      target = centres.filter((c, i) => i !== from && c < centre).length;
      tabs.forEach((other, i) => {
        if (other === tab) return;
        const shift = i > from && i <= target ? -width : i < from && i >= target ? width : 0;
        other.style.transform = shift ? `translateX(${shift}px)` : '';
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!dragging) {
        store.select(repo.path);
        return;
      }
      bar.classList.remove('reordering');
      if (target !== from) store.reorder(repo.path, target);
      else renderTabbar(bar);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

export function renderTabbar(container) {
  mount(container,
    homeTab(),
    store.repositories.map(repoTab),
    h('button', { type: 'button', class: 'icon-btn add-tab', title: t('action.repo.add'), onclick: () => store.add() }, icon('plus', 16)),
  );
  container.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

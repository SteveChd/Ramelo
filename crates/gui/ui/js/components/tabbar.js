// Tabs: the overview of all repositories, the pinned tabs, then the other tabs, which scroll when
// they do not fit (wheel, arrows, or the list of all open tabs). A tab is dragged to change the
// order; the middle button closes it, as in a browser. A closed tab's repository stays in the
// overview, from where it is opened again.

import { t, tn } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon, repoColor } from '../lib/icons.js';
import { store } from '../state/store.js';
import { repoState } from './badges.js';
import { closeContextMenu, openContextMenu } from './context-menu.js';
import { openRepoMenu } from './repo-menu.js';

/** Distance the pointer must travel before a click becomes a drag. */
const DRAG_THRESHOLD = 5;

export function avatar(repo, className = 'avatar') {
  return h('span', { class: className, style: { background: repoColor(repo) }, 'aria-hidden': 'true' }, [...repo.name][0] ?? '?');
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
    class: `tab${repo.pinned ? ' pinned' : ''}`,
    role: 'tab',
    tabindex: '0',
    'aria-selected': String(store.active === repo.path),
    title: repo.path,
    dataset: { path: repo.path },
    style: { '--repo': repoColor(repo) },
    oncontextmenu: (event) => openRepoMenu(event, repo),
    onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') store.select(repo.path); },
    onauxclick: (event) => { if (event.button === 1) store.close(repo.path); },
  },
  avatar(repo),
  h('span', { class: 'name' }, repo.name),
  ['dirty', 'conflict', 'error'].includes(state) && h('span', { class: `state-dot ${state}` }),
  // A pinned tab has no close button, so that it is not closed by mistake (its menu closes it).
  !repo.pinned && h('button', {
    type: 'button',
    class: 'close',
    title: t('tabs.close'),
    onpointerdown: (event) => event.stopPropagation(),
    onclick: (event) => { event.stopPropagation(); store.close(repo.path); },
  }, icon('close', 13, 2.2)));
  installDrag(tab, repo);
  return tab;
}

/** Click selects the tab; a drag moves it among the other repository tabs. */
function installDrag(tab, repo) {
  tab.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // A tab moves among the tabs of its group: the pinned ones, or the others.
    const bar = tab.parentElement;
    const tabs = [...bar.querySelectorAll('.tab[data-path]')];
    const before = repo.pinned ? 0 : store.tabs.filter((r) => r.pinned).length;
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
      if (target !== from) store.moveTab(repo.path, before + target);
      else renderTabbar(bar.closest('.tabbar'));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/** The list of all open tabs, with a field to find one by name or path. */
export function openTabList(at = document.querySelector('.tabbar .tab-list-btn')) {
  if (!at) return;
  const tabs = store.tabs;
  const list = h('div', { class: 'tab-list-items', role: 'listbox' });
  const field = h('input', { type: 'search', class: 'tab-list-field', placeholder: t('tabs.find'), autofocus: true, spellcheck: 'false' });
  let shown = [];
  let cursor = 0;
  const choose = (repo) => { closeContextMenu(); store.select(repo.path); };
  const draw = () => {
    const words = field.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    shown = tabs.filter((r) => words.every((w) => r.name.toLowerCase().includes(w) || r.path.toLowerCase().includes(w)));
    cursor = Math.min(cursor, Math.max(shown.length - 1, 0));
    mount(list, shown.length === 0 ? h('div', { class: 'tab-list-empty' }, t('tabs.noMatch')) : shown.map((repo, i) => {
      const state = repoState(repo);
      return h('div', {
        class: `tab-list-row${i === cursor ? ' cursor' : ''}${repo.path === store.active ? ' current' : ''}`,
        role: 'option',
        'aria-selected': String(i === cursor),
        title: repo.path,
        onclick: () => choose(repo),
        onpointermove: () => { if (cursor !== i) { cursor = i; draw(); } },
      },
      avatar(repo),
      h('span', { class: 'name' }, repo.name),
      h('span', { class: 'where' }, repo.path),
      ['dirty', 'conflict', 'error'].includes(state) && h('span', { class: `state-dot ${state}` }),
      h('button', {
        type: 'button',
        class: `icon-btn pin${repo.pinned ? ' on' : ''}`,
        title: t(repo.pinned ? 'tabs.unpin' : 'tabs.pin'),
        onclick: (event) => { event.stopPropagation(); closeContextMenu(); store.setPinned(repo.path, !repo.pinned); },
      }, icon('pin', 14)),
      !repo.pinned && h('button', {
        type: 'button',
        class: 'icon-btn',
        title: t('tabs.close'),
        onclick: (event) => { event.stopPropagation(); closeContextMenu(); store.close(repo.path); },
      }, icon('close', 13, 2.2)));
    }));
    list.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
  };
  field.addEventListener('input', () => { cursor = 0; draw(); });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = (cursor + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(shown.length, 1);
      draw();
    } else if (event.key === 'Enter' && shown[cursor]) {
      event.preventDefault();
      choose(shown[cursor]);
    }
  });
  cursor = Math.max(0, tabs.findIndex((r) => r.path === store.active));
  draw();
  const menu = openContextMenu(at, [h('div', { class: 'tab-list' },
    h('div', { class: 'tab-list-head' }, icon('search', 14), field),
    list)]);
  menu?.classList.add('tab-list-menu');
  // Opened from the keyboard, the list stays inside the window on the right.
  list.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
}

/** Arrows shown only when the tabs do not fit; each one is greyed at its end. */
function updateScroll(bar) {
  const scroller = bar.querySelector('.tabs-scroll');
  if (!scroller) return;
  const overflow = scroller.scrollWidth > scroller.clientWidth + 1;
  bar.classList.toggle('overflow', overflow);
  bar.querySelector('.scroll-prev').disabled = scroller.scrollLeft <= 0;
  bar.querySelector('.scroll-next').disabled = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1;
}

function scrollBy(bar, direction) {
  const scroller = bar.querySelector('.tabs-scroll');
  scroller.scrollBy({ left: direction * scroller.clientWidth * 0.7, behavior: 'smooth' });
}

/** Brings the active tab to the middle of the scrolling part when it is not well in view. */
function revealActive(scroller) {
  const tab = scroller.querySelector('[aria-selected="true"]');
  if (!tab) return;
  const t = tab.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  const margin = 24;
  if (t.left >= s.left + margin && t.right <= s.right - margin) return;
  scroller.scrollLeft += t.left + t.width / 2 - (s.left + s.width / 2);
}

let shownActive;
const observed = new WeakSet();

export function renderTabbar(container) {
  const previous = container.querySelector('.tabs-scroll')?.scrollLeft ?? 0;
  const tabs = store.tabs;
  const pinned = tabs.filter((r) => r.pinned);
  const others = tabs.filter((r) => !r.pinned);
  const scroller = h('div', {
    class: 'tabs-scroll',
    role: 'presentation',
    onscroll: () => updateScroll(container),
    // The wheel scrolls the tabs sideways.
    onwheel: (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      scroller.scrollLeft += event.deltaY;
    },
  }, others.map(repoTab));
  mount(container,
    homeTab(),
    pinned.length > 0 && h('div', { class: 'tabs-pinned', role: 'presentation' }, pinned.map(repoTab)),
    scroller,
    h('div', { class: 'tab-tools' },
      h('button', { type: 'button', class: 'icon-btn scroll-prev', title: t('tabs.scrollPrev'), onclick: () => scrollBy(container, -1) }, icon('chevron', 15, 2.2)),
      h('button', { type: 'button', class: 'icon-btn scroll-next', title: t('tabs.scrollNext'), onclick: () => scrollBy(container, 1) }, icon('chevron', 15, 2.2)),
      tabs.length > 0 && h('button', {
        type: 'button',
        class: 'btn tab-list-btn',
        title: `${t('tabs.list')} (Ctrl+Shift+A)`,
        onclick: (event) => openTabList(event.currentTarget),
      }, icon('chevron', 14, 2.2), h('span', {}, tn('tabs.count', tabs.length))),
      h('button', {
        type: 'button',
        class: 'icon-btn add-tab',
        title: `${t('action.repo.add')} / ${t('action.repo.clone')}`,
        onclick: (event) => openContextMenu(event.currentTarget, [
          { label: t('action.repo.add'), icon: 'folder', hint: 'Ctrl+O', run: () => store.add() },
          { label: t('action.repo.clone'), icon: 'fetch', hint: 'Ctrl+Shift+O', run: () => store.clone() },
          { label: t('action.repo.find'), icon: 'search', hint: 'Ctrl+Shift+N', run: () => store.find() },
        ]),
      }, icon('plus', 16))),
  );
  scroller.scrollLeft = previous;
  // The active tab is brought into view when it changes, not at each refresh.
  if (shownActive !== store.active) {
    shownActive = store.active;
    requestAnimationFrame(() => revealActive(scroller));
  }
  if (!observed.has(container)) {
    observed.add(container);
    new ResizeObserver(() => updateScroll(container)).observe(container);
  }
  updateScroll(container);
}

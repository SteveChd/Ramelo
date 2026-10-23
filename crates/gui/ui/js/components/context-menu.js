// Context menu, opened by a right click or from a button: a few actions, and any element (such as
// colour swatches). It closes on a click outside, Escape, a scroll or when the window loses focus.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

let current = null;

export function closeContextMenu() {
  current?.remove();
  current = null;
}

window.addEventListener('pointerdown', (event) => { if (current && !current.contains(event.target)) closeContextMenu(); }, true);
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && current) { event.stopPropagation(); closeContextMenu(); } }, true);
window.addEventListener('blur', closeContextMenu);
window.addEventListener('resize', closeContextMenu);
document.addEventListener('scroll', closeContextMenu, true);

/**
 * `items`: '-' for a separator, an element shown as it is, or { label, icon, hint, danger, disabled, run }.
 * `at`: a mouse event (the menu opens at the pointer) or an element (the menu opens below it).
 */
export function openContextMenu(at, items) {
  closeContextMenu();
  const menu = h('div', { class: 'menu context', role: 'menu', oncontextmenu: (e) => e.preventDefault() },
    items.filter(Boolean).map((item) => {
      if (item === '-') return h('div', { class: 'sep' });
      if (item instanceof Node) return item;
      return h('button', {
        type: 'button',
        class: `mi${item.danger ? ' danger' : ''}`,
        role: 'menuitem',
        disabled: item.disabled,
        onclick: () => { closeContextMenu(); item.run(); },
      }, item.icon ? icon(item.icon, 15) : h('span', { class: 'ico-space' }), h('span', { class: 'lbl' }, item.label), item.hint && h('span', { class: 'key' }, item.hint));
    }));
  document.body.append(menu);
  current = menu;

  let x;
  let y;
  if (at instanceof Event) {
    at.preventDefault();
    x = at.clientX;
    y = at.clientY;
  } else {
    const rect = at.getBoundingClientRect();
    x = rect.left;
    y = rect.bottom + 4;
  }
  // Kept inside the window.
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(4, y + height > window.innerHeight - 4 ? y - height : y)}px`;
  menu.querySelector('.mi:not(:disabled)')?.focus();
}

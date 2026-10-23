// Menu bar: logo, drop-down menus, language and theme.

import { isEnabled, label, run, shortcut } from '../app/actions.js';
import { LANGUAGES, language, setLanguage, t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon, logo } from '../lib/icons.js';
import { currentTheme, toggleTheme } from './theme.js';

const MENUS = [
  { label: 'menu.file', items: ['repo.add', '-', 'repo.openFolder', 'repo.remove'] },
  { label: 'menu.repository', items: ['repo.fetch', 'repo.pull', 'repo.push', '-', 'repo.newBranch', 'repo.stageAll', '-', 'repo.refresh', 'repo.refreshAll'] },
  { label: 'menu.view', items: ['view.home', 'view.nextTab', 'view.prevTab', '-', 'view.toggleLeft', 'view.toggleRight', 'view.toggleDiff', 'view.maximizeDiff', '-', 'view.theme'] },
];

let openMenu = null;

function closeMenu() {
  openMenu?.remove();
  document.querySelector('.menu-btn[aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
  openMenu = null;
}
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });

function menuItem(name) {
  if (name === '-') return h('div', { class: 'sep' });
  const key = shortcut(name);
  return h('button', {
    type: 'button',
    class: 'mi',
    role: 'menuitem',
    disabled: !isEnabled(name),
    onclick: () => { closeMenu(); run(name); },
  }, h('span', { class: 'lbl' }, label(name)), key && h('span', { class: 'key' }, key));
}

function menuButton(menu) {
  const button = h('button', { type: 'button', class: 'menu-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, t(menu.label));
  const wrap = h('div', { class: 'menu-wrap' }, button);
  const open = () => {
    closeMenu();
    openMenu = h('div', { class: 'menu', role: 'menu' }, menu.items.map(menuItem));
    wrap.append(openMenu);
    button.setAttribute('aria-expanded', 'true');
  };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (button.getAttribute('aria-expanded') === 'true') closeMenu();
    else open();
  });
  // As in a desktop application: hovering another menu opens it when a menu is already open.
  button.addEventListener('mouseenter', () => { if (openMenu && !wrap.contains(openMenu)) open(); });
  return wrap;
}

function languageSwitch() {
  return h('div', { class: 'seg lang-switch', role: 'group', 'aria-label': t('menu.language') },
    LANGUAGES.map((lang) => h('button', {
      type: 'button',
      'aria-pressed': String(language() === lang),
      onclick: () => setLanguage(lang),
    }, lang.toUpperCase())));
}

export function renderMenubar(container) {
  closeMenu();
  const dark = currentTheme() === 'dark';
  mount(container,
    logo(),
    h('span', { class: 'app-name' }, 'GitController'),
    MENUS.map(menuButton),
    h('div', { class: 'spacer' }),
    languageSwitch(),
    h('button', {
      type: 'button',
      class: 'icon-btn',
      title: t(dark ? 'menu.lightTheme' : 'menu.darkTheme'),
      onclick: toggleTheme,
    }, icon(dark ? 'sun' : 'moon')),
  );
}

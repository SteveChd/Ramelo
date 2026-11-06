// Entry point of the interface: mounts the components and shows the active tab.

import * as backend from './api/backend.js';
import { installKeyboard } from './app/keyboard.js';
import { hideSplash, splashStep } from './app/splash.js';
import { renderMenubar } from './components/menubar.js';
import { renderStatusbar } from './components/statusbar.js';
import { renderTabbar } from './components/tabbar.js';
import { initTheme, onThemeChange } from './components/theme.js';
import { toast } from './components/toast.js';
import { language, onLanguageChange, t } from './i18n/i18n.js';
import { h } from './lib/dom.js';
import { pulls } from './state/pulls.js';
import { store } from './state/store.js';
import { renderHome } from './views/home/home-view.js';
import { renderRepo } from './views/repo/repo-view.js';

/** Coming back to the window reads every repository again, at most this often. */
const FOCUS_REFRESH_MS = 5000;

const $ = (id) => document.getElementById(id);

function renderView() {
  const repo = store.activeRepo;
  if (repo) renderRepo($('view-host'), repo);
  else renderHome($('view-host'));
}

function renderAll() {
  renderMenubar($('menubar'));
  renderTabbar($('tabbar'));
  renderView();
  renderStatusbar($('statusbar'));
}

/** The pull requests of the repositories that have a remote, read in the background. */
function refreshPulls(force = false) {
  const paths = store.repositories.filter((r) => r.summary?.remotes.length).map((r) => r.path);
  pulls.refresh(paths, { force }).catch(() => {});
}

/** New pull requests shown in the overview, drawn again once per frame at most. */
function installPullIndicators() {
  let pending = false;
  pulls.subscribe((path) => {
    // Accounts changed: everything is read again for them.
    if (path === null) refreshPulls();
    if (pending || store.activeRepo) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!store.activeRepo) renderHome($('view-host'));
    });
  });
}

/** Folders dropped onto the window are added to the workspace. */
function installDrop() {
  const overlay = h('div', { class: 'drop-overlay', hidden: true }, t('home.dropHere'));
  document.body.append(overlay);
  backend.onFoldersDropped(
    (paths) => store.add(paths),
    (hovering) => {
      overlay.textContent = t('home.dropHere');
      overlay.hidden = !hovering;
    },
  );
}

/** The user may have committed or pulled elsewhere: the state is read again when the window comes back. */
function installFocusRefresh() {
  let last = Date.now();
  window.addEventListener('focus', () => {
    if (Date.now() - last < FOCUS_REFRESH_MS || store.repositories.length === 0) return;
    last = Date.now();
    store.refresh(null);
    refreshPulls();
  });
}

/**
 * The menu of the web view (Back, Reload, Save as, Print…) means nothing in an application: it is
 * kept only where text can be typed or is selected, for Cut, Copy and Paste. The menus of the
 * application call preventDefault themselves and are left alone.
 */
function installNativeMenuGuard() {
  window.addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    const editable = target?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
    const selected = String(window.getSelection() ?? '').trim() !== '';
    if (!editable && !selected) event.preventDefault();
  });
}

async function start() {
  splashStep(t('splash.engine'), 0.15);
  initTheme();
  // The backend uses the chosen language for its native dialogs.
  backend.setLanguage(language()).catch(() => {});
  onLanguageChange((lang) => {
    backend.setLanguage(lang).catch(() => {});
    renderAll();
  });
  onThemeChange(() => renderMenubar($('menubar')));

  splashStep(t('splash.ui'), 0.35);
  installKeyboard();
  installNativeMenuGuard();
  installDrop();
  installFocusRefresh();
  installPullIndicators();
  store.subscribe((topic, _state, detail) => {
    if (topic === 'workspace') {
      renderAll();
      refreshPulls();
    }
    if (topic === 'ui') renderView();
    if (topic === 'busy') renderStatusbar($('statusbar'));
    if (topic === 'notice') toast(detail, 3200);
    if (topic === 'error') toast(detail, 6000);
  });

  splashStep(t('splash.repos'), 0.45);
  const snapshot = await backend.startup().catch((error) => {
    toast(String(error?.message ?? error), 6000);
    return { repositories: [], active: null };
  });
  store.load(snapshot);
  // Each repository read moves the bar forward, the one shown first.
  await store.readAll((done, total) => splashStep(t('splash.reading', { done, n: total }), 0.45 + (0.5 * done) / total));
  splashStep(t('splash.render', { n: snapshot.repositories.length }), 0.97);
  await hideSplash(t('splash.ready'));
}

start();

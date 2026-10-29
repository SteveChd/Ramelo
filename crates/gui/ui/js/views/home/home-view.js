// Overview of all repositories: a card per repository with its branch, what is left to push or pull,
// its changes and its last commit. A click opens the repository's tab.

import { needsSync, repoBadges, repoState } from '../../components/badges.js';
import { openRepoMenu } from '../../components/repo-menu.js';
import { avatar } from '../../components/tabbar.js';
import { describeError } from '../../app/errors.js';
import { t, tn } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon, logo, repoColor } from '../../lib/icons.js';
import { fullDate, relativeTime } from '../../lib/time.js';
import { store } from '../../state/store.js';

const FILTERS = {
  all: () => true,
  changes: (repo) => ['dirty', 'conflict'].includes(repoState(repo)),
  sync: needsSync,
  attention: (repo) => ['conflict', 'error'].includes(repoState(repo)),
};

/** Lower case and without accents, so that « deploiement » finds « Déploiement ». */
const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * A repository matches when each word typed is found in its name, path, branch, upstream, or last
 * commit (message or author), in any order.
 */
function matchesSearch(repo, text) {
  const words = fold(text).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const s = repo.summary;
  const haystack = fold([repo.name, repo.path, s?.head.branch, s?.upstream, s?.lastCommit?.summary, s?.lastCommit?.author].filter(Boolean).join('\n'));
  return words.every((word) => haystack.includes(word));
}

function emptyState() {
  return h('div', { class: 'empty' },
    logo(),
    h('h2', {}, t('home.emptyTitle')),
    h('p', {}, t('home.emptyText')),
    h('div', { class: 'empty-actions' },
      h('button', { type: 'button', class: 'btn primary large', onclick: () => store.add() }, icon('plus', 16), t('action.repo.add')),
      h('button', { type: 'button', class: 'btn large', onclick: () => store.clone() }, icon('fetch', 16), t('action.repo.clone'))),
    h('p', { class: 'hint' }, t('home.dropHint')),
  );
}

function card(repo) {
  const s = repo.summary;
  const attention = ['conflict', 'error'].includes(repoState(repo));
  return h('article', { class: `card${attention ? ' attention' : ''}`, style: { '--repo': repoColor(repo) }, oncontextmenu: (event) => openRepoMenu(event, repo) },
    h('button', { type: 'button', class: 'card-open', 'aria-label': t('home.open', { name: repo.name }), onclick: () => store.select(repo.path) }),
    h('div', { class: 'card-head' },
      avatar(repo, 'avatar large'),
      h('div', { class: 'card-title' },
        h('span', { class: 'name' }, repo.name),
        // Shown right-to-left so that a long path is cut at its start and keeps the useful end.
        h('span', { class: 'path', title: repo.path }, h('bdi', {}, repo.path))),
      h('div', { class: 'card-actions' },
        h('button', { type: 'button', class: 'icon-btn', title: t('action.repo.openFolder'), onclick: () => store.openFolder(repo.path) }, icon('folder', 16)),
        h('button', { type: 'button', class: 'icon-btn', title: t('action.repo.refresh'), onclick: () => store.refresh(repo.path) }, icon('refresh', 16)),
        h('button', { type: 'button', class: 'icon-btn', title: t('action.repo.remove'), onclick: () => store.remove(repo.path) }, icon('remove', 16)))),
    h('div', { class: 'badges' }, repoBadges(repo)),
    repo.error && h('div', { class: 'error-text' }, describeError(repo.error)),
    s?.lastCommit && h('div', { class: 'last-commit', title: `${s.lastCommit.summary}\n${s.lastCommit.author} · ${fullDate(s.lastCommit.time)}` },
      icon('commit', 14),
      h('span', { class: 'summary' }, s.lastCommit.summary),
      h('span', { class: 'meta' }, `· ${relativeTime(s.lastCommit.time)}`)),
  );
}

function filterSwitch() {
  return h('div', { class: 'seg', role: 'group', 'aria-label': t('home.filter') },
    Object.keys(FILTERS).map((name) => {
      const count = store.repositories.filter(FILTERS[name]).length;
      return h('button', {
        type: 'button',
        'aria-pressed': String(store.ui.filter === name),
        onclick: () => store.setFilter(name),
      }, t(`home.filters.${name}`), name !== 'all' && count > 0 ? ` ${count}` : '');
    }));
}

/** Search field kept between renders, so that typing is never interrupted. */
let searchField = null;

function search() {
  if (!searchField) {
    searchField = h('input', { type: 'search', oninput: (event) => store.setSearch(event.target.value) });
  }
  searchField.placeholder = t('home.search');
  return searchField;
}

export function renderHome(container) {
  const repos = store.repositories;
  if (repos.length === 0) {
    mount(container, emptyState());
    return;
  }
  const visible = repos.filter(FILTERS[store.ui.filter]).filter((r) => matchesSearch(r, store.ui.search));
  // Drawing again detaches the field, which takes its focus away: give it back, caret included.
  const typing = searchField !== null && document.activeElement === searchField;
  const caret = typing ? [searchField.selectionStart, searchField.selectionEnd, searchField.selectionDirection] : null;
  mount(container, h('div', { class: 'home' },
    h('div', { class: 'home-head' },
      h('h2', {}, t('home.title')),
      h('span', { class: 'count' }, tn('status.repos', repos.length)),
      h('div', { class: 'spacer' }),
      search(),
      filterSwitch(),
      h('button', { type: 'button', class: 'btn', onclick: () => store.refresh(null) }, icon('refresh', 15), t('home.refreshAll')),
      // With a filter or a search, only the repositories shown are offered for removal.
      h('button', {
        type: 'button',
        class: 'icon-btn remove-all',
        title: visible.length < repos.length ? tn('home.removeShown', visible.length) : t('home.removeAll'),
        disabled: visible.length === 0,
        onclick: () => store.removeMany(visible.length < repos.length ? visible.map((r) => r.path) : null),
      }, icon('remove', 16)),
      h('button', { type: 'button', class: 'btn', onclick: () => store.clone() }, icon('fetch', 15), t('clone.short')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => store.add() }, icon('plus', 15), t('action.repo.add'))),
    visible.length
      ? h('div', { class: 'cards' }, visible.map(card))
      : h('div', { class: 'no-match' }, t('home.noMatch')),
  ));
  if (typing) {
    searchField.focus({ preventScroll: true });
    searchField.setSelectionRange(...caret);
  }
}

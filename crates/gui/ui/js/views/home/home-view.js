// Overview of all repositories: a card per repository with its branch, what is left to push or pull,
// its changes and its last commit. A click opens the repository's tab. Repositories can be filed
// under sections (a team, a product…), each folded or not; a card is dragged from one to another.

import { needsSync, repoBadges, repoState } from '../../components/badges.js';
import { openContextMenu } from '../../components/context-menu.js';
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
  return h('article', {
    class: `card${attention ? ' attention' : ''}`,
    style: { '--repo': repoColor(repo) },
    oncontextmenu: (event) => openRepoMenu(event, repo),
    onpointerdown: (event) => {
      if (!event.target.closest('.card-actions')) startDrag(event, { repo: repo.path, label: repo.name });
    },
  },
    h('button', { type: 'button', class: 'card-open', 'aria-label': t('home.open', { name: repo.name }), onclick: () => store.select(repo.path) }),
    h('div', { class: 'card-head' },
      avatar(repo, 'avatar large'),
      h('div', { class: 'card-title' },
        h('span', { class: 'name' }, repo.name),
        // Shown right-to-left so that a long path is cut at its start and keeps the useful end.
        h('span', { class: 'path', title: repo.path }, h('bdi', {}, repo.path))),
      h('div', { class: 'card-actions' },
        h('button', { type: 'button', class: 'icon-btn', title: t('action.repo.openFolder'), onclick: () => store.openFolder(repo.path) }, icon('folder', 16)),
        h('button', { type: 'button', class: 'icon-btn', title: t('action.repo.openVsCode'), onclick: () => store.openInVsCode(repo.path) }, icon('code', 16)),
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

/**
 * The search scope in force: the one chosen, unless its section is gone (renamed or removed), in
 * which case the search looks everywhere again.
 */
function scopeOf() {
  const scope = store.ui.scope;
  if (!scope || store.sections.length === 0) return null;
  return scope.section === null || store.sections.some((s) => s.name === scope.section) ? scope : null;
}

/** Whether `repo` is where the search looks. */
function inScope(repo, scope) {
  if (!scope) return true;
  const named = store.sections.some((s) => s.name === repo.section);
  return scope.section === null ? !named : repo.section === scope.section;
}

/** Picks where the search looks, when there are sections. */
function scopePicker(scope) {
  if (store.sections.length === 0) return null;
  const others = '\u0000others';
  const value = !scope ? '' : scope.section === null ? others : scope.section;
  const select = h('select', {
    class: 'scope',
    'aria-label': t('home.scope'),
    title: t('home.scope'),
    onchange: (event) => {
      const v = event.target.value;
      store.setScope(v === '' ? null : { section: v === others ? null : v });
    },
  },
  h('option', { value: '' }, t('home.scopeAll')),
  store.sections.map((s) => h('option', { value: s.name }, s.name)),
  h('option', { value: others }, t('sections.others')));
  select.value = value;
  return select;
}

/** Searches in one section (`name` null: the repositories in no section). */
function searchIn(name) {
  store.setScope({ section: name });
  searchField?.focus();
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

/** Beyond this distance in pixels, a press on a card or a section header becomes a drag. */
const DRAG_THRESHOLD = 5;

/**
 * Drags a repository card to another section (`what.repo`), or a section by its header before another
 * one (`what.section`). Pointer events rather than HTML drag and drop, which the window keeps for
 * folders dropped from the file manager. A label follows the pointer; the group under it is lit.
 */
function startDrag(event, what) {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let ghost = null;
  let target = null;

  const accepts = (group) => group && (what.repo || !group.classList.contains('others'));
  const move = (e) => {
    if (!ghost && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
    if (!ghost) {
      ghost = h('div', { class: 'drag-ghost' }, icon(what.repo ? 'folder' : 'layers', 14), what.label);
      document.body.append(ghost);
      document.body.classList.add('dragging-home');
    }
    ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
    const group = document.elementFromPoint(e.clientX, e.clientY)?.closest('.group');
    const next = accepts(group) ? group : null;
    if (next !== target) {
      target?.classList.remove('drop-target');
      next?.classList.add('drop-target');
      target = next;
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('keydown', cancel, true);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove('dragging-home');
    target?.classList.remove('drop-target');
    // The click that ends a drag does not open the card or fold the section.
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    if (!target) return;
    const name = target.dataset.section ?? null;
    if (what.repo) {
      const repo = store.repositories.find((r) => r.path === what.repo);
      if (repo && (repo.section ?? null) !== name) store.setSection([what.repo], name);
    } else if (name !== null && name !== what.section) {
      store.moveSection(what.section, store.sections.findIndex((s) => s.name === name));
    }
  };
  const cancel = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    target?.classList.remove('drop-target');
    target = null;
    up();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', cancel, true);
}

function sectionMenu(event, name) {
  const index = store.sections.findIndex((s) => s.name === name);
  openContextMenu(event, [
    { label: t('sections.searchIn'), icon: 'search', run: () => searchIn(name) },
    '-',
    { label: t('sections.rename'), icon: 'edit', run: () => store.renameSection(name) },
    { label: t('sections.moveUp'), icon: 'arrowUp', disabled: index <= 0, run: () => store.moveSection(name, index - 1) },
    { label: t('sections.moveDown'), icon: 'arrowDown', disabled: index >= store.sections.length - 1, run: () => store.moveSection(name, index + 1) },
    '-',
    { label: t('sections.new'), icon: 'plus', run: () => store.newSection() },
    '-',
    { label: t('sections.remove'), icon: 'remove', danger: true, run: () => store.removeSection(name) },
  ]);
}

/**
 * One section and its cards (`name` null: the repositories in no section). `shown` are its
 * repositories that pass the filter and the search, `total` how many it holds; `outside`: the search
 * is limited to another section.
 */
function group(name, shown, total, collapsed, narrowed, scope) {
  const searched = Boolean(scope) && scope.section === name;
  const outside = Boolean(scope) && !searched;
  const others = name === null;
  const title = others ? t('sections.others') : name;
  const head = h('div', {
    class: 'group-head',
    oncontextmenu: others ? null : (event) => sectionMenu(event, name),
    onpointerdown: others ? null : (event) => {
      if (!event.target.closest('.group-actions')) startDrag(event, { section: name, label: name });
    },
  },
  h('button', { type: 'button', class: 'group-toggle', 'aria-expanded': String(!collapsed), onclick: () => store.toggleSection(name) },
    icon('chevron', 14, 2.2),
    h('span', { class: 'group-name' }, title),
    h('span', { class: 'n' }, shown.length < total ? `${shown.length} / ${total}` : String(total))),
  h('div', { class: 'group-actions' },
    h('button', {
      type: 'button',
      class: `icon-btn${searched ? ' active' : ''}`,
      title: searched ? t('home.scopeAll') : t('sections.searchIn'),
      'aria-pressed': String(searched),
      onclick: () => (searched ? store.setScope(null) : searchIn(name)),
    }, icon('search', 14)),
    !others && h('button', { type: 'button', class: 'icon-btn', title: t('sections.rename'), onclick: () => store.renameSection(name) }, icon('edit', 14)),
    !others && h('button', { type: 'button', class: 'icon-btn', title: t('sections.remove'), onclick: () => store.removeSection(name) }, icon('remove', 14))));
  const body = collapsed ? null
    : shown.length ? h('div', { class: 'cards' }, shown.map(card))
      // While narrowed, a section with no match stays as a place to drop the repositories found.
      : outside && total > 0 ? h('div', { class: 'group-empty compact' }, t('sections.outOfScopeHint'))
        : narrowed && total > 0 ? h('div', { class: 'group-empty compact' }, t('sections.noMatchHint'))
        : h('div', { class: 'group-empty' }, t('sections.emptyHint'));
  return h('section', { class: `group${collapsed ? ' collapsed' : ''}${others ? ' others' : ''}${outside ? ' outside' : ''}${searched ? ' searched' : ''}`, 'data-section': others ? null : name }, head, body);
}

/**
 * The cards, in their sections when there are some. The sections always stay, even with nothing to
 * show, so that a repository found by a search can be dragged into any of them, or back among the
 * repositories in no section (left out only when there are none). A search unfolds the sections, so
 * that no match stays hidden.
 */
function cardList(repos, visible, scope) {
  if (store.sections.length === 0) {
    return visible.length ? h('div', { class: 'cards' }, visible.map(card)) : h('div', { class: 'no-match' }, t('home.noMatch'));
  }
  const narrowed = visible.length < repos.length;
  const searching = store.ui.search.trim() !== '' || Boolean(scope);
  const names = new Set(store.sections.map((s) => s.name));
  const of = (name) => (r) => (name === null ? !names.has(r.section) : r.section === name);
  const groups = [...store.sections.map((s) => [s.name, s.collapsed]), [null, store.othersCollapsed]]
    .map(([name, collapsed]) => ({ name, collapsed: Boolean(collapsed) && !searching, shown: visible.filter(of(name)), total: repos.filter(of(name)).length }))
    .filter((g) => g.name !== null || g.total > 0);
  return h('div', { class: 'groups' },
    narrowed && visible.length === 0 && h('div', { class: 'no-match' }, t('home.noMatch')),
    groups.map((g) => group(g.name, g.shown, g.total, g.collapsed && !(scope && scope.section === g.name), narrowed, scope)));
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
  const scope = scopeOf();
  const visible = repos.filter(FILTERS[store.ui.filter]).filter((r) => inScope(r, scope) && matchesSearch(r, store.ui.search));
  // Drawing again detaches the field, which takes its focus away: give it back, caret included.
  const typing = searchField !== null && document.activeElement === searchField;
  const caret = typing ? [searchField.selectionStart, searchField.selectionEnd, searchField.selectionDirection] : null;
  mount(container, h('div', { class: 'home' },
    h('div', { class: 'home-head' },
      h('h2', {}, t('home.title')),
      h('span', { class: 'count' }, tn('status.repos', repos.length)),
      h('div', { class: 'spacer' }),
      h('div', { class: 'search-box' }, scopePicker(scope), search()),
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
      h('button', { type: 'button', class: 'icon-btn new-section', title: t('sections.new'), onclick: () => store.newSection() }, icon('layers', 16)),
      h('button', { type: 'button', class: 'btn', onclick: () => store.clone() }, icon('fetch', 15), t('clone.short')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => store.add() }, icon('plus', 15), t('action.repo.add'))),
    cardList(repos, visible, scope),
  ));
  if (typing) {
    searchField.focus({ preventScroll: true });
    searchField.setSelectionRange(...caret);
  }
}

// The open pull requests of the repository, when one of its remotes is on an account, then its
// branches: local ones (with what they have to push or pull), its worktrees, remote branches grouped
// by remote, and tags. A double click switches to a branch or a worktree (in the same tab); a click
// shows its commit in the graph.

import * as backend from '../../api/backend.js';
import { describeError } from '../../app/errors.js';
import { t } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openContextMenu } from '../../components/context-menu.js';
import { openNewPullDialog } from '../../components/new-pull-dialog.js';
import { pullView } from '../../state/pull-view.js';
import { pulls } from '../../state/pulls.js';
import { watch } from '../../state/watch.js';
import { repoStore } from '../../state/repo-store.js';

/** Sections folded by the user, remembered while the application runs. */
const folded = new Set(['tags']);

// Heights given to the sections by dragging the bar under one of them, remembered between
// sessions. A section without one takes the height of its content, the long ones giving way first.
const SIZES_KEY = 'ramelo.sidebarSections';
const ROW = 28;
const TITLE = 30;
let sizes = {};
try { sizes = JSON.parse(localStorage.getItem(SIZES_KEY) ?? '{}') ?? {}; } catch { /* sizes not remembered */ }

function saveSizes() {
  try { localStorage.setItem(SIZES_KEY, JSON.stringify(sizes)); } catch { /* sizes not remembered */ }
}

/** Smallest height of an open section: its title and two rows (fewer when it has fewer). */
function rowCount(body) {
  return body ? body.querySelectorAll('.sb-item, .sb-group, .sb-empty').length : 0;
}

function minHeight(sectionEl) {
  const rows = rowCount(sectionEl.querySelector(':scope > .sb-body'));
  return TITLE + Math.min(rows, 2) * ROW;
}

/** Sizes the open sections, from the heights given by hand or else from their content. */
function layoutSections(container) {
  const open = [...container.querySelectorAll(':scope > .sb-section')].filter((el) => el.querySelector(':scope > .sb-body'));
  for (const el of container.querySelectorAll(':scope > .sb-section')) {
    const body = el.querySelector(':scope > .sb-body');
    if (!body) { el.style.flex = ''; el.style.minHeight = ''; continue; }
    // No bar under the last open section: there is nothing below to take its height.
    el.querySelector(':scope > .sb-sash').hidden = el === open.at(-1);
    const rows = rowCount(body);
    el.style.minHeight = `${minHeight(el)}px`;
    const size = sizes[el.dataset.key];
    // Rows are counted rather than measured, as the sidebar may not be on screen yet.
    el.style.flex = size ? `1 1 ${size}px` : `0 ${rows * rows} auto`;
  }
}

/** The bar under an open section: dragging it moves height between that section and the next open one. */
function sash(key) {
  const bar = h('div', { class: 'sb-sash', role: 'separator', 'aria-orientation': 'horizontal', title: t('branch.resizeSections') });
  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const container = bar.closest('.sidebar');
    const open = [...container.querySelectorAll(':scope > .sb-section')].filter((el) => el.querySelector(':scope > .sb-body'));
    const above = open.find((el) => el.dataset.key === key);
    const below = open[open.indexOf(above) + 1];
    if (!above || !below) return;
    event.preventDefault();
    // Every open section keeps the height it has now, so that only these two change.
    for (const el of open) {
      sizes[el.dataset.key] = Math.round(el.getBoundingClientRect().height);
    }
    layoutSections(container);
    const start = event.clientY;
    const total = sizes[above.dataset.key] + sizes[below.dataset.key];
    const first = sizes[above.dataset.key];
    const [minAbove, minBelow] = [minHeight(above), minHeight(below)];
    bar.setPointerCapture(event.pointerId);
    bar.classList.add('active');
    document.body.classList.add('resizing-y');
    const move = (e) => {
      const height = Math.max(minAbove, Math.min(total - minBelow, first + e.clientY - start));
      sizes[above.dataset.key] = height;
      sizes[below.dataset.key] = total - height;
      layoutSections(container);
    };
    const end = () => {
      bar.removeEventListener('pointermove', move);
      bar.classList.remove('active');
      document.body.classList.remove('resizing-y');
      saveSizes();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', end, { once: true });
    bar.addEventListener('pointercancel', end, { once: true });
  });
  // A double click gives every section back the height of its content.
  bar.addEventListener('dblclick', () => {
    sizes = {};
    saveSizes();
    layoutSections(bar.closest('.sidebar'));
  });
  return bar;
}

function section(key, title, count, content, extra = null) {
  const open = !folded.has(key);
  return h('div', { class: 'sb-section', 'data-key': key },
    h('div', { class: 'sb-title' },
      h('button', {
        type: 'button',
        class: 'sb-head',
        'aria-expanded': String(open),
        onclick: () => {
          if (open) folded.add(key); else folded.delete(key);
          renderSidebar(document.querySelector('.sidebar'));
        },
      }, icon('chevron', 13, 2.2), title, h('span', { class: 'n' }, count)),
      extra),
    open && h('div', { class: 'sb-body', 'data-key': key }, content),
    open && sash(key));
}

function trackInfo(branch) {
  if (branch.gone) return h('span', { class: 'gone', title: t('branch.goneHint') }, t('branch.gone'));
  if (!branch.ahead && !branch.behind) return null;
  return h('span', { class: 'track' },
    branch.ahead > 0 && h('span', { class: 'up' }, `↑${branch.ahead}`),
    branch.behind > 0 && h('span', { class: 'down' }, `↓${branch.behind}`));
}

/** What the graph shows of a branch or tag, from its right click. */
function graphMenu(event, ref, extra = []) {
  const shown = repoStore.isShown(ref);
  const filtered = Boolean(repoStore.state.filter);
  openContextMenu(event, [
    { label: t('graph.soloRef'), icon: 'filter', run: () => repoStore.soloRef(ref) },
    filtered && { label: shown ? t('graph.hideRefMenu') : t('graph.showRef'), icon: shown ? 'minus' : 'plus', run: () => repoStore.toggleRef(ref) },
    filtered && { label: t('graph.showAll'), run: () => repoStore.setFilter(null) },
    extra.length > 0 && '-',
    ...extra,
  ]);
}

/** A branch the graph does not show is dimmed. */
const dimmed = (ref) => (repoStore.isShown(ref) ? '' : ' not-shown');

function localItem(branch) {
  return h('div', {
    class: `sb-item${branch.isHead ? ' head' : ''}${dimmed({ kind: 'local', name: branch.name })}`,
    title: branch.upstream ? t('badge.tracking', { upstream: branch.upstream }) : branch.summary,
    onclick: () => repoStore.selectCommit(branch.oid),
    oncontextmenu: (event) => graphMenu(event, { kind: 'local', name: branch.name }, [
      !branch.isHead && { label: branch.worktree ? t('worktree.switchHere') : t('branch.switch'), icon: 'swap', run: () => repoStore.switchTo(branch.name) },
      { label: t('branch.newHere'), icon: 'plus', run: () => repoStore.createBranch(branch.oid) },
      !branch.isHead && !branch.worktree && { label: t('wt.fromBranch'), icon: 'folder', run: () => repoStore.addWorktree({ branch: branch.name }) },
      !branch.isHead && { label: t('branch.deleteTitle'), icon: 'remove', danger: true, run: () => repoStore.deleteBranch(branch.name) },
    ].filter(Boolean)),
    ondblclick: () => { if (!branch.isHead) repoStore.switchTo(branch.name); },
  },
  h('span', { class: 'lbl' }, branch.name),
  branch.worktree && h('span', { class: 'wt', title: t('worktree.badge', { folder: branch.worktree }) }, icon('folder', 13)),
  trackInfo(branch),
  h('span', { class: 'acts' },
    !branch.isHead && h('button', { type: 'button', class: 'icon-btn', title: t('branch.switch'), onclick: (e) => { e.stopPropagation(); repoStore.switchTo(branch.name); } }, icon('swap', 14)),
    h('button', { type: 'button', class: 'icon-btn', title: t('branch.newHere'), onclick: (e) => { e.stopPropagation(); repoStore.createBranch(branch.oid); } }, icon('plus', 14)),
    !branch.isHead && h('button', { type: 'button', class: 'icon-btn', title: t('branch.deleteTitle'), onclick: (e) => { e.stopPropagation(); repoStore.deleteBranch(branch.name); } }, icon('remove', 14))));
}

function remoteItem(branch) {
  const [, ...rest] = branch.name.split('/');
  return h('div', {
    class: `sb-item nested${dimmed({ kind: 'remote', name: branch.name })}`,
    title: branch.summary,
    onclick: () => repoStore.selectCommit(branch.oid),
    oncontextmenu: (event) => graphMenu(event, { kind: 'remote', name: branch.name }, [
      { label: t('branch.detachRemote'), icon: 'swap', run: () => repoStore.switchTo(branch.name, false, { detach: true }) },
      { label: t('branch.checkoutRemote'), icon: 'newBranch', run: () => repoStore.switchTo(branch.name) },
      { label: t('wt.fromRemote'), icon: 'folder', run: () => repoStore.addWorktree({ start: branch.name }) },
    ]),
    ondblclick: () => repoStore.switchTo(branch.name, false, { detach: true }),
  },
  h('span', { class: 'lbl' }, rest.join('/')),
  h('span', { class: 'acts' },
    h('button', { type: 'button', class: 'icon-btn', title: t('branch.detachRemote'), onclick: (e) => { e.stopPropagation(); repoStore.switchTo(branch.name, false, { detach: true }); } }, icon('swap', 14)),
    h('button', { type: 'button', class: 'icon-btn', title: t('branch.checkoutRemote'), onclick: (e) => { e.stopPropagation(); repoStore.switchTo(branch.name); } }, icon('newBranch', 14))));
}

const folderName = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function worktreeItem(wt) {
  const what = wt.branch ?? (wt.head ? t('wt.detached', { oid: wt.head.slice(0, 7) }) : '');
  const removable = !wt.main && !wt.current;
  return h('div', {
    class: `sb-item wt-item${wt.current ? ' head' : ''}${wt.missing ? ' missing' : ''}`,
    title: `${wt.path}${wt.missing ? `\n${t('wt.missing')}` : ''}${wt.locked ? `\n${t('wt.locked')}` : ''}`,
    onclick: () => { if (wt.head) repoStore.selectCommit(wt.head); },
    ondblclick: () => { if (!wt.current && !wt.missing) repoStore.switchWorktree(wt.path); },
    oncontextmenu: (event) => openContextMenu(event, [
      !wt.current && !wt.missing && { label: t('worktree.switchHere'), icon: 'swap', run: () => repoStore.switchWorktree(wt.path) },
      !wt.missing && { label: t('wt.openFolder'), icon: 'folder', run: () => backend.openFolder(wt.path).catch(() => {}) },
      removable && '-',
      removable && { label: t('wt.removeTitle'), icon: 'remove', danger: true, run: () => repoStore.removeWorktree(wt) },
    ].filter(Boolean)),
  },
  icon('folder', 13),
  h('span', { class: 'lbl' }, folderName(wt.path)),
  h('span', { class: 'wt-branch' }, wt.main ? `${what} · ${t('wt.main')}` : what),
  h('span', { class: 'acts' },
    !wt.current && !wt.missing && h('button', { type: 'button', class: 'icon-btn', title: t('worktree.switchHere'), onclick: (e) => { e.stopPropagation(); repoStore.switchWorktree(wt.path); } }, icon('swap', 14)),
    removable && h('button', { type: 'button', class: 'icon-btn', title: t('wt.removeTitle'), onclick: (e) => { e.stopPropagation(); repoStore.removeWorktree(wt); } }, icon('remove', 14))));
}

function worktreeSection() {
  const list = repoStore.state.worktrees;
  if (!list) return null;
  return section('worktrees', t('wt.section'), list.length, list.map(worktreeItem),
    h('button', { type: 'button', class: 'icon-btn small', title: t('wt.newTitle'), onclick: () => repoStore.addWorktree() }, icon('plus', 14)));
}

function pullItem(pull, path) {
  const shown = pullView.state.path === path && pullView.state.number === pull.number;
  return h('div', {
    class: `sb-item pull-item${shown ? ' shown' : ''}${pull.draft ? ' draft' : ''}`,
    title: `#${pull.number} ${pull.title}\n${pull.sourceBranch} → ${pull.targetBranch} · ${pull.author}`,
    onclick: () => (shown ? pullView.close() : pullView.open(path, pull.number)),
  },
  h('span', { class: 'pull-n' }, `#${pull.number}`),
  h('span', { class: 'lbl' }, pull.title),
  pull.reviewRequested && h('span', { class: 'review-mark', title: t('pr.reviewRequested') }),
  pull.draft && h('span', { class: 'draft-mark' }, t('pr.state.draft')));
}

/** Nothing when the repository is on no account; the list, or why it cannot be read. */
function pullSection(path) {
  const entry = pulls.of(path);
  if (!entry || (!entry.hosting && !entry.error)) return null;
  const list = entry.pulls ?? [];
  const watched = watch.isWatched(path);
  const tools = h('span', { class: 'sb-tools' },
    entry.hosting && h('button', {
      type: 'button',
      class: `icon-btn small watch-btn${watched ? ' on' : ''}`,
      title: watched ? t('watch.stop') : t('watch.start'),
      'aria-pressed': String(watched),
      onclick: () => watch.toggle(path),
    }, icon('bell', 13)),
    h('button', {
      type: 'button',
      class: `icon-btn small${entry.loading ? ' spinning' : ''}`,
      title: t('pr.refreshList'),
      disabled: entry.loading,
      onclick: () => pulls.reload(path),
    }, icon('refresh', 13)),
    entry.hosting && h('button', {
      type: 'button',
      class: 'icon-btn small',
      title: t('pr.openList'),
      onclick: () => backend.openUrl(entry.hosting.webUrl).catch(() => {}),
    }, icon('external', 13)),
    entry.hosting && h('button', { type: 'button', class: 'icon-btn small', title: t('action.repo.newPull'), onclick: () => openNewPullDialog(path) }, icon('plus', 14)));
  return section('pulls', t('pr.section'), list.length,
    entry.error && !list.length ? h('div', { class: 'sb-empty error', title: describeError(entry.error) }, t('pr.unreadable'))
      : list.length ? list.map((p) => pullItem(p, path))
        : entry.loading ? h('div', { class: 'sb-empty waiting' }, h('span', { class: 'spinner' }), t('repo.loading'))
          : h('div', { class: 'sb-empty' }, t('pr.none')),
    tools);
}

export function renderSidebar(container) {
  if (!container) return;
  const refs = repoStore.state.refs;
  if (!refs) {
    mount(container, h('div', { class: 'loading' }, h('span', { class: 'spinner' }), t('repo.loading')));
    return;
  }
  const byRemote = new Map();
  for (const branch of refs.remote) {
    const remote = branch.name.split('/')[0];
    if (!byRemote.has(remote)) byRemote.set(remote, []);
    byRemote.get(remote).push(branch);
  }
  // Local branches by name, the current one first.
  const local = [...refs.local].sort((a, b) => Number(b.isHead) - Number(a.isHead) || a.name.localeCompare(b.name));
  const sortedRemotes = [...byRemote.entries()].sort(([a], [b]) => a.localeCompare(b));
  // Each section scrolls on its own, so that every title stays in view; a new render keeps where
  // each one was scrolled to.
  const scrolled = new Map([...container.querySelectorAll('.sb-body')].map((body) => [body.dataset.key, body.scrollTop]));
  mount(container,
    pullSection(repoStore.state.path),
    section('local', t('branch.local'), local.length,
      local.length ? local.map(localItem) : h('div', { class: 'sb-empty' }, t('branch.noLocal')),
      h('button', { type: 'button', class: 'icon-btn small', title: t('repo.newBranch'), onclick: () => repoStore.createBranch() }, icon('plus', 14))),
    worktreeSection(),
    section('remote', t('branch.remote'), refs.remote.length,
      refs.remote.length
        ? sortedRemotes.map(([remote, branches]) => h('div', { class: 'sb-remote' },
          h('div', { class: 'sb-group' }, icon('cloud', 13), remote),
          branches.sort((a, b) => a.name.localeCompare(b.name)).map(remoteItem)))
        : h('div', { class: 'sb-empty' }, t('branch.noRemote'))),
    section('tags', t('branch.tags'), refs.tags.length,
      refs.tags.length
        ? refs.tags.map((tag) => h('div', {
          class: `sb-item${dimmed({ kind: 'tag', name: tag.name })}`,
          onclick: () => repoStore.selectCommit(tag.oid),
          oncontextmenu: (event) => graphMenu(event, { kind: 'tag', name: tag.name }),
        }, icon('tag', 13), h('span', { class: 'lbl' }, tag.name)))
        : h('div', { class: 'sb-empty' }, t('branch.noTags'))),
  );
  layoutSections(container);
  for (const body of container.querySelectorAll('.sb-body')) body.scrollTop = scrolled.get(body.dataset.key) ?? 0;
}

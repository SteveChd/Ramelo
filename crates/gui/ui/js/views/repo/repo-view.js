// One repository, in the style of a desktop git client: toolbar on top, branches on the left, the
// commit graph in the centre with the diff of a file below it, and on the right the working copy with
// the commit box, or the details of the selected commit.
//
// The side panels and the diff panel can be resized with their splitters and folded; the diff can
// also take the whole centre. The layout is built once per repository; each part is then drawn
// again only when what it shows changes, so that scrolling and typing are never interrupted.

import { t } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { describeError } from '../../app/errors.js';
import { shortcut } from '../../app/actions.js';
import { splitter } from '../../components/splitter.js';
import { layout } from '../../state/layout.js';
import { repoStore } from '../../state/repo-store.js';
import { search } from '../../state/search.js';
import { store } from '../../state/store.js';
import { renderDetailsPanel } from './details-panel.js';
import { renderDiff } from './diff-view.js';
import { diffKey } from './files.js';
import { revealCommit, renderGraph, updateGraphSelection } from './graph.js';
import { renderSearchBar } from './search-bar.js';
import { renderSidebar } from './sidebar.js';
import { renderToolbar } from './toolbar.js';
import { renderWipPanel, updateWipRunning } from './wip-panel.js';

let view = null;

/**
 * Narrow strip along a side panel, always shown: its arrow points where the panel goes when
 * clicked (into the edge to fold it, out of it to unfold it).
 */
function strip(side) {
  return h('button', { type: 'button', class: `strip ${side}`, onclick: () => layout.toggle(`${side}Collapsed`) }, icon('chevron', 14, 2.4));
}

function updateStrip(el, side, action) {
  const folded = layout.state[`${side}Collapsed`];
  const key = shortcut(action);
  el.classList.toggle('folded', folded);
  el.title = `${t(folded ? `panel.show.${side}` : `panel.hide.${side}`)}${key ? ` (${key})` : ''}`;
  el.setAttribute('aria-expanded', String(!folded));
}

function build(container, repo) {
  const parts = {
    toolbar: h('div', { class: 'repo-toolbar' }),
    banner: h('div', { class: 'op-banner', hidden: true }),
    search: h('div', { class: 'search-host', hidden: true }),
    sidebar: h('div', { class: 'panel-body sidebar' }),
    graph: h('div', { class: 'graph' }),
    diff: h('div', { class: 'diff-panel', hidden: true }),
    side: h('div', { class: 'panel-body side' }),
  };
  parts.left = h('aside', { class: 'panel left', 'aria-label': t('branch.aria') }, parts.sidebar);
  parts.right = h('aside', { class: 'panel right' }, parts.side);
  parts.stripLeft = strip('left');
  parts.stripRight = strip('right');
  parts.splitLeft = splitter({ name: 'left', axis: 'x', sign: 1, fold: 'leftCollapsed', title: t('panel.resize') });
  parts.splitRight = splitter({ name: 'right', axis: 'x', sign: -1, fold: 'rightCollapsed', title: t('panel.resize') });
  parts.splitDiff = splitter({ name: 'diff', axis: 'y', sign: -1, fold: 'diffCollapsed', title: t('panel.resize') });
  parts.center = h('section', { class: 'center' }, parts.search, parts.graph, parts.splitDiff, parts.diff);
  parts.main = h('div', { class: 'repo-main' }, parts.left, parts.splitLeft, parts.stripLeft, parts.center, parts.stripRight, parts.splitRight, parts.right);
  const root = h('div', { class: 'repo' }, parts.toolbar, parts.banner, parts.main);
  mount(container, root);
  view = { path: repo.path, root, diffKey: null, ...parts };
  applyLayout();
}

/** Sizes and folds of the panels, from the layout. */
function applyLayout() {
  if (!view) return;
  const l = layout.state;
  const hasDiff = Boolean(repoStore.state.diff);
  view.main.style.setProperty('--left-w', `${l.left}px`);
  view.main.style.setProperty('--right-w', `${l.right}px`);
  view.center.style.setProperty('--diff-h', `${l.diff}px`);
  view.left.classList.toggle('collapsed', l.leftCollapsed);
  view.right.classList.toggle('collapsed', l.rightCollapsed);
  view.splitLeft.hidden = l.leftCollapsed;
  view.splitRight.hidden = l.rightCollapsed;
  updateStrip(view.stripLeft, 'left', 'view.toggleLeft');
  updateStrip(view.stripRight, 'right', 'view.toggleRight');
  view.diff.hidden = !hasDiff;
  view.diff.classList.toggle('collapsed', hasDiff && l.diffCollapsed);
  const maximized = hasDiff && l.diffMaximized && !l.diffCollapsed;
  view.center.classList.toggle('diff-max', maximized);
  view.splitDiff.hidden = !hasDiff || l.diffCollapsed || maximized;
}

function renderBanner(repo) {
  const operation = repo.summary?.operation;
  view.banner.hidden = !operation;
  if (operation) mount(view.banner, icon('warning', 18), t(`repo.inProgress.${operation}`));
}

function renderGraphPart(repo) {
  renderGraph(view.graph, repo);
}

/** A file opened in a folded diff panel unfolds it: the user asked to see it. */
function renderDiffPart() {
  const diff = repoStore.state.diff;
  const key = diff ? `${diff.kind}:${diff.oid ?? ''}:${diff.staged ?? ''}:${diff.file}` : null;
  if (key && key !== view.diffKey && layout.state.diffCollapsed) layout.set({ diffCollapsed: false });
  view.diffKey = key;
  applyLayout();
  if (diff) renderDiff(view.diff);
}

/** Draws the right panel; its list keeps its scroll position while the same thing is shown. */
function renderSide(repo) {
  const selection = repoStore.state.selection;
  const scroll = view.sideFor === selection ? view.side.querySelector('.side-scroll')?.scrollTop ?? 0 : 0;
  if (selection === 'wip') renderWipPanel(view.side, repo);
  else renderDetailsPanel(view.side);
  view.sideFor = selection;
  const list = view.side.querySelector('.side-scroll');
  if (list) list.scrollTop = scroll;
}

/** Opening another file only moves the highlight in the lists. */
function markOpenFile() {
  const key = diffKey(repoStore.state.diff);
  for (const row of view.side.querySelectorAll('.frow[data-key]')) row.classList.toggle('open', row.dataset.key === key);
}

function renderError(container, repo) {
  view = null;
  mount(container, h('div', { class: 'empty' },
    icon('warning', 40),
    h('h2', {}, repo.name),
    h('p', {}, describeError(repo.error)),
    h('button', { type: 'button', class: 'btn', onclick: () => store.remove(repo.path) }, icon('close', 15), t('action.repo.remove'))));
}

export function renderRepo(container, repo) {
  if (repo.error) {
    renderError(container, repo);
    return;
  }
  const fresh = !view || view.path !== repo.path || !container.contains(view.root);
  // Each repository starts with its own, empty search.
  if (fresh && view?.path !== repo.path) search.reset();
  if (fresh) build(container, repo);
  if (fresh && repoStore.state.path !== repo.path) repoStore.open(repo.path);
  else repoStore.workspaceChanged();
  renderToolbar(view.toolbar, repo);
  renderBanner(repo);
  renderSearchBar(view.search);
  renderSidebar(view.sidebar);
  renderGraphPart(repo);
  renderDiffPart();
  renderSide(repo);
}

/** Folds and diff style shown by the toolbar and the diff panel; sizes alone only need `applyLayout`. */
const folds = (l) => `${l.leftCollapsed}${l.rightCollapsed}${l.diffCollapsed}${l.diffMaximized}${l.diffSplit}`;
let lastFolds = folds(layout.state);

layout.subscribe((l) => {
  applyLayout();
  const changed = folds(l) !== lastFolds;
  lastFolds = folds(l);
  const repo = store.activeRepo;
  if (changed && view && repo && repo.path === view.path) {
    renderToolbar(view.toolbar, repo);
    if (repoStore.state.diff) renderDiff(view.diff);
  }
});

repoStore.subscribe((topic) => {
  const repo = store.activeRepo;
  if (!view || !repo || repo.path !== view.path) return;
  if (topic === 'history') renderGraphPart(repo);
  if (topic === 'refs') renderSidebar(view.sidebar);
  if (topic === 'selection') {
    renderSide(repo);
    updateGraphSelection(view.graph);
    renderDiffPart();
  }
  if (topic === 'details') renderSide(repo);
  if (topic === 'diff') {
    renderDiffPart();
    markOpenFile();
  }
  if (topic === 'reveal') revealCommit(view.graph, repoStore.state.reveal);
  if (topic === 'running') {
    renderToolbar(view.toolbar, repo);
    updateWipRunning(repo);
  }
  if (topic === 'draft') renderSide(repo);
});

/** What the graph shows of a search: drawn again only when that changes, not at each key typed. */
const searchShown = (s) => `${search.active}${s.onlyMatches}${s.result?.oids.length}${s.query ? JSON.stringify(s.query) : ''}`;
let lastSearch = searchShown(search.state);

search.subscribe((s) => {
  const repo = store.activeRepo;
  if (!view || !repo || repo.path !== view.path) return;
  renderSearchBar(view.search);
  const shown = searchShown(s);
  if (shown !== lastSearch) renderGraphPart(repo);
  lastSearch = shown;
});

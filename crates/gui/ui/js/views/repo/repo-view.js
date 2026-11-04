// One repository, in the style of a desktop git client: toolbar on top, branches on the left, the
// commit graph in the centre with the diff of a file below it, and on the right the working copy with
// the commit box, or the details of the selected commit.
//
// The side panels and the diff panel can be resized with their splitters and folded; the diff can
// also take the whole centre. The layout is built once per repository; each part is then drawn
// again only when what it shows changes, so that scrolling and typing are never interrupted.

import { t, tn } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { describeError } from '../../app/errors.js';
import { shortcut } from '../../app/actions.js';
import { splitter } from '../../components/splitter.js';
import { layout } from '../../state/layout.js';
import { pullView } from '../../state/pull-view.js';
import { pulls } from '../../state/pulls.js';
import { repoStore } from '../../state/repo-store.js';
import { search } from '../../state/search.js';
import { store } from '../../state/store.js';
import { watch } from '../../state/watch.js';
import { renderDetailsPanel } from './details-panel.js';
import { renderDiff } from './diff-view.js';
import { diffKey } from './files.js';
import { revealCommit, renderGraph, updateGraphSelection } from './graph.js';
import { markPullFile, renderPull } from './pull-view.js';
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
  return h('button', { type: 'button', class: `strip ${side}`, onclick: () => layout.toggle(`${side}Collapsed`) },
    h('span', { class: 'strip-tab' }, icon('chevron', 14, 2.4)));
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
    pull: h('div', { class: 'pull', hidden: true }),
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
  parts.center = h('section', { class: 'center' }, parts.search, parts.graph, parts.pull, parts.splitDiff, parts.diff);
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
  // The conflict editor needs room: it always takes the whole centre.
  const conflict = repoStore.state.diff?.kind === 'conflict';
  if (conflict) view.diff.classList.remove('collapsed');
  const maximized = hasDiff && (conflict || (l.diffMaximized && !l.diffCollapsed));
  view.center.classList.toggle('diff-max', maximized);
  view.splitDiff.hidden = !hasDiff || (l.diffCollapsed && !conflict) || maximized;
}

/** The operation in progress, with what can be done about it: continue, skip the commit, abort. */
function renderBanner(repo) {
  const summary = repo.summary;
  const operation = summary?.operation;
  view.banner.hidden = !operation;
  if (!operation) return;
  const busy = Boolean(repoStore.state.running);
  const left = summary.conflicted;
  const button = (label, onclick, { kind = '', disabled = false, title = null } = {}) =>
    h('button', { type: 'button', class: `btn${kind}`, disabled: busy || disabled, title, onclick }, label);
  const actions = operation === 'bisect'
    ? [button(t('conflict.abort.bisect'), () => repoStore.abortOperation())]
    : [
      ['rebase', 'cherryPick', 'revert'].includes(operation) && button(t('conflict.skip'), () => repoStore.skipCommit(), { title: t('conflict.skipHint') }),
      button(t(`conflict.abort.${operation}`), () => repoStore.abortOperation(), { kind: ' danger' }),
      button(t('conflict.continue'), () => repoStore.continueOperation(), {
        kind: ' primary',
        disabled: left > 0,
        title: left > 0 ? tn('conflict.resolveFirst', left) : null,
      }),
    ];
  mount(view.banner,
    icon('warning', 18),
    h('span', { class: 'op-text' }, t(`repo.inProgress.${operation}`)),
    left > 0 && h('span', { class: 'op-left' }, tn('conflict.files', left)),
    h('div', { class: 'op-actions' }, actions));
}

function renderGraphPart(repo) {
  if (pullView.state.number !== null) return;
  renderGraph(view.graph, repo);
}

/** The pull request open in the centre takes the place of the graph and of the search. */
function renderPullPart(repo) {
  const open = pullView.state.number !== null && pullView.state.path === repo.path;
  const was = !view.pull.hidden;
  view.pull.hidden = !open;
  view.graph.hidden = open;
  view.center.classList.toggle('with-pull', open);
  if (open) {
    view.search.hidden = true;
    renderPull(view.pull);
  } else if (was) {
    renderSearchBar(view.search);
    renderGraph(view.graph, repo);
  }
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
  renderPullPart(repo);
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

// A repository watched or no longer: the bell of its pull requests follows.
watch.subscribe(() => {
  if (view && store.activeRepo?.path === view.path) renderSidebar(view.sidebar);
});

repoStore.subscribe((topic) => {
  const repo = store.activeRepo;
  if (!view || !repo || repo.path !== view.path) return;
  if (topic === 'history') renderGraphPart(repo);
  if (topic === 'refs') renderSidebar(view.sidebar);
  if (topic === 'filter') {
    renderSidebar(view.sidebar);
    renderGraphPart(repo);
  }
  if (topic === 'selection') {
    renderSide(repo);
    updateGraphSelection(view.graph);
    renderDiffPart();
  }
  if (topic === 'details') renderSide(repo);
  if (topic === 'diff') {
    renderDiffPart();
    markOpenFile();
    markPullFile(view.pull);
  }
  if (topic === 'reveal') revealCommit(view.graph, repoStore.state.reveal);
  if (topic === 'running') {
    renderToolbar(view.toolbar, repo);
    renderBanner(repo);
    updateWipRunning(repo);
  }
  if (topic === 'draft') renderSide(repo);
});

/** What the graph shows of a search: drawn again only when that changes, not at each key typed. */
const searchShown = (s) => `${search.active}${s.onlyMatches}${s.result?.oids.length}${s.query ? JSON.stringify(s.query) : ''}`;
let lastSearch = searchShown(search.state);

pullView.subscribe(() => {
  const repo = store.activeRepo;
  if (!view || !repo || repo.path !== view.path) return;
  renderPullPart(repo);
  renderSidebar(view.sidebar);
  // The comments under the lines of the open file follow the pull request.
  if (repoStore.state.diff?.kind === 'range') renderDiff(view.diff);
});

// The pull requests of the repository were read again: the list of the side panel follows.
pulls.subscribe((path) => {
  const repo = store.activeRepo;
  if (!view || !repo || repo.path !== view.path || (path !== null && path !== repo.path)) return;
  renderSidebar(view.sidebar);
});

search.subscribe((s) => {
  const repo = store.activeRepo;
  if (!view || !repo || repo.path !== view.path) return;
  if (pullView.state.number !== null) return;
  renderSearchBar(view.search);
  const shown = searchShown(s);
  if (shown !== lastSearch) renderGraphPart(repo);
  lastSearch = shown;
});

// One repository, in the style of a desktop git client: toolbar on top, branches on the left, the
// commit graph (or the diff of a file) in the centre, and on the right the working copy with the
// commit box, or the details of the selected commit.
//
// The layout is built once per repository; each part is then drawn again only when what it shows
// changes, so that scrolling and typing are never interrupted.

import { t } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { describeError } from '../../app/errors.js';
import { repoStore } from '../../state/repo-store.js';
import { store } from '../../state/store.js';
import { renderDetailsPanel } from './details-panel.js';
import { renderDiff } from './diff-view.js';
import { renderGraph, updateGraphSelection } from './graph.js';
import { renderSidebar } from './sidebar.js';
import { renderToolbar } from './toolbar.js';
import { renderWipPanel, updateWipRunning } from './wip-panel.js';

let view = null;

function build(container, repo) {
  const parts = {
    toolbar: h('div', { class: 'repo-toolbar' }),
    banner: h('div', { class: 'op-banner', hidden: true }),
    sidebar: h('aside', { class: 'sidebar', 'aria-label': t('branch.aria') }),
    center: h('section', { class: 'center' }),
    graph: h('div', { class: 'graph' }),
    side: h('aside', { class: 'side' }),
  };
  const root = h('div', { class: 'repo' }, parts.toolbar, parts.banner, h('div', { class: 'repo-main' }, parts.sidebar, parts.center, parts.side));
  mount(container, root);
  view = { path: repo.path, root, ...parts };
}

function renderBanner(repo) {
  const operation = repo.summary?.operation;
  view.banner.hidden = !operation;
  if (operation) mount(view.banner, icon('warning', 18), t(`repo.inProgress.${operation}`));
}

function renderCenter(repo) {
  if (repoStore.state.diff) {
    renderDiff(view.center);
    return;
  }
  // The graph keeps its element (and its scroll position) when the diff closes.
  if (view.center.firstChild !== view.graph) mount(view.center, view.graph);
  renderGraph(view.graph, repo);
}

function renderSide(repo) {
  if (repoStore.state.selection === 'wip') renderWipPanel(view.side, repo);
  else renderDetailsPanel(view.side);
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
  if (fresh) build(container, repo);
  if (fresh && repoStore.state.path !== repo.path) repoStore.open(repo.path);
  else repoStore.workspaceChanged();
  renderToolbar(view.toolbar, repo);
  renderBanner(repo);
  renderSidebar(view.sidebar);
  renderCenter(repo);
  renderSide(repo);
}

repoStore.subscribe((topic) => {
  const repo = store.activeRepo;
  if (!view || !repo || repo.path !== view.path) return;
  if (topic === 'history') renderCenter(repo);
  if (topic === 'refs') renderSidebar(view.sidebar);
  if (topic === 'selection') {
    renderSide(repo);
    if (repoStore.state.diff) renderCenter(repo);
    else updateGraphSelection(view.graph);
  }
  if (topic === 'details') renderSide(repo);
  if (topic === 'diff') {
    renderCenter(repo);
    renderSide(repo);
  }
  if (topic === 'running') {
    renderToolbar(view.toolbar, repo);
    updateWipRunning(repo);
  }
  if (topic === 'draft') renderSide(repo);
});

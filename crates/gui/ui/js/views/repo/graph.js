// Commit graph: the working copy first when it has changes, then one row per commit. The lanes come
// laid out from the backend; each row draws the lines above and below its dot.

import { t, tn } from '../../i18n/i18n.js';
import { h, mount, s } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { fullDate, relativeTime } from '../../lib/time.js';
import { openContextMenu } from '../../components/context-menu.js';
import { repoStore } from '../../state/repo-store.js';
import { store } from '../../state/store.js';

const ROW = 28;
const LANE = 16;
const PAD = 12;
/** Beyond this many lanes the graph column stops growing (the rest is clipped). */
const MAX_LANES = 14;

const laneX = (lane) => PAD + lane * LANE;
const laneColor = (color) => `var(--g${color % 8})`;

function path(from, to, y1, y2) {
  const x1 = laneX(from);
  const x2 = laneX(to);
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}

function laneSvg(row, width, isHead) {
  const g = row.graph;
  const lines = [
    ...g.top.map((e) => s('path', { d: path(e.from, e.to, 0, ROW / 2), stroke: laneColor(e.color) })),
    ...g.bottom.map((e) => s('path', { d: path(e.from, e.to, ROW / 2, ROW), stroke: laneColor(e.color) })),
  ];
  const cx = laneX(g.lane);
  const color = laneColor(g.color);
  const dot = row.parents.length > 1
    ? s('circle', { cx, cy: ROW / 2, r: 3.6, fill: 'var(--panel)', stroke: color, 'stroke-width': 2.2 })
    : s('circle', { cx, cy: ROW / 2, r: 4.6, fill: color });
  return s('svg', { width, height: ROW, fill: 'none', 'stroke-width': 2, 'aria-hidden': 'true' },
    lines,
    isHead && s('circle', { cx, cy: ROW / 2, r: 7.5, stroke: color, 'stroke-width': 1.6, opacity: 0.55 }),
    dot);
}

/**
 * References of a commit as labels. A local branch and its remote on the same commit show as one
 * label with a cloud, to keep the column readable.
 */
function refLabels(row) {
  const color = laneColor(row.graph.color);
  const locals = new Set(row.refs.filter((r) => r.kind === 'branch').map((r) => r.name));
  const synced = new Set();
  const labels = [];
  for (const ref of row.refs) {
    if (ref.kind === 'remote') {
      const local = ref.name.split('/').slice(1).join('/');
      if (locals.has(local)) { synced.add(local); continue; }
    }
    labels.push(ref);
  }
  return labels.map((ref) => {
    const cls = ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'remote' : ref.isHead ? 'head' : '';
    const iconName = ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : ref.kind === 'head' ? 'commit' : null;
    return h('span', { class: `ref ${cls}`, style: { '--lane': color }, title: ref.name },
      iconName && icon(iconName, 12, 2),
      ref.kind === 'head' ? t('graph.detached') : ref.name,
      synced.has(ref.name) && icon('cloud', 12, 2));
  });
}

/** Right click on a commit: branch from it, switch to it or to one of its branches, copy its id. */
function commitMenu(event, row, headOid) {
  repoStore.selectCommit(row.oid);
  const current = store.activeRepo?.summary?.head.branch;
  const branches = row.refs.filter((r) => r.kind === 'branch' && r.name !== current);
  openContextMenu(event, [
    { label: t('graph.branchHere'), icon: 'newBranch', run: () => repoStore.createBranch(row.oid) },
    branches.map((b) => ({ label: t('graph.switchTo', { name: b.name }), icon: 'swap', run: () => repoStore.switchTo(b.name) })),
    { label: t('graph.checkoutCommit'), icon: 'commit', disabled: row.oid === headOid && !current, run: () => repoStore.switchTo(row.oid) },
    '-',
    { label: t('graph.copySha'), icon: 'tag', run: () => copy(row.oid) },
    { label: t('graph.copySummary'), run: () => copy(row.summary) },
  ].flat());
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    store.notify(t('notice.copied'));
  } catch {
    store.notify(t('notice.copyFailed'), true);
  }
}

function commitRow(row, width, headOid, selected) {
  return h('div', {
    class: `grow${selected ? ' selected' : ''}${row.parents.length > 1 ? ' merge' : ''}`,
    dataset: { oid: row.oid },
    onclick: () => repoStore.selectCommit(row.oid),
    oncontextmenu: (event) => commitMenu(event, row, headOid),
  },
  laneSvg(row, width, row.oid === headOid),
  h('div', { class: 'msg' }, refLabels(row), h('span', { class: 'text', title: row.summary }, row.summary),
    h('button', {
      type: 'button',
      class: 'row-act',
      title: t('graph.branchHere'),
      onclick: (event) => { event.stopPropagation(); repoStore.createBranch(row.oid); },
    }, icon('newBranch', 14, 2))),
  h('span', { class: 'author', title: row.email }, row.author),
  h('span', { class: 'date', title: fullDate(row.time) }, relativeTime(row.time)),
  h('span', { class: 'sha' }, row.oid.slice(0, 7)));
}

function wipRow(summary, width, headLane, selected) {
  const cx = laneX(headLane ?? 0);
  return h('div', { class: `grow wip${selected ? ' selected' : ''}`, onclick: () => repoStore.selectWip() },
    s('svg', { width, height: ROW, fill: 'none', 'aria-hidden': 'true' },
      headLane !== null && s('path', { d: `M${cx} ${ROW / 2 + 5}V${ROW}`, stroke: 'var(--muted)', 'stroke-width': 2, 'stroke-dasharray': '2 3' }),
      s('circle', { cx, cy: ROW / 2, r: 4.6, stroke: 'var(--muted)', 'stroke-width': 2, 'stroke-dasharray': '2.5 2' })),
    h('div', { class: 'msg' }, h('span', { class: 'text' }, tn('graph.wip', summary.fileCount))),
    h('span', {}), h('span', {}), h('span', {}));
}

/** Keeps the scroll position when the graph is drawn again with the same history. */
let lastHistory = null;

export function renderGraph(container, repo) {
  const { history, selection } = repoStore.state;
  if (!history) {
    mount(container, h('div', { class: 'loading' }, t('repo.loading')));
    lastHistory = null;
    return;
  }
  const summary = repo.summary;
  const headOid = summary?.head.oid ?? null;
  const headRowIndex = history.rows.findIndex((r) => r.oid === headOid);
  // Only HEAD's lane continues down to the WIP row when HEAD is the first row.
  const headLane = headRowIndex === 0 ? history.rows[0].graph.lane : headRowIndex > 0 ? null : 0;
  const width = PAD * 2 + (Math.min(history.width, MAX_LANES) - 1) * LANE + 4;
  const scroll = lastHistory === history ? container.scrollTop : 0;
  const dirty = summary && summary.fileCount > 0;

  container.style.setProperty('--graph-w', `${Math.max(width, 56)}px`);
  mount(container,
    h('div', { class: 'graph-head' },
      h('span', {}, t('graph.graph')), h('span', {}, t('graph.message')), h('span', {}, t('graph.author')), h('span', {}, t('graph.date')), h('span', {}, t('graph.sha'))),
    dirty && wipRow(summary, Math.max(width, 56), headLane, selection === 'wip'),
    history.rows.length === 0 && !dirty && h('div', { class: 'graph-empty' }, t('graph.empty')),
    history.rows.map((row) => commitRow(row, Math.max(width, 56), headOid, selection === row.oid)),
    history.hasMore && h('div', { class: 'load-more' },
      h('button', { type: 'button', class: 'btn', onclick: () => repoStore.loadMore() }, t('graph.loadMore'))),
  );
  container.scrollTop = scroll;
  lastHistory = history;
}

/** Selection changed: only the highlighted row changes, and the selected commit is scrolled into view. */
export function updateGraphSelection(container) {
  const { selection } = repoStore.state;
  for (const row of container.querySelectorAll('.grow.selected')) row.classList.remove('selected');
  const target = selection === 'wip' ? container.querySelector('.grow.wip') : container.querySelector(`.grow[data-oid="${selection}"]`);
  target?.classList.add('selected');
  target?.scrollIntoView({ block: 'nearest' });
}

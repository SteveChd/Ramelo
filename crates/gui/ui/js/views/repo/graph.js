// Commit graph: the working copy first when it has changes, then one row per commit. The lanes come
// laid out from the backend; each row draws the lines above and below its dot.

import { t, tn } from '../../i18n/i18n.js';
import { h, mount, s } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { fullDate, relativeTime } from '../../lib/time.js';
import { openContextMenu } from '../../components/context-menu.js';
import { repoStore } from '../../state/repo-store.js';
import { search } from '../../state/search.js';
import { store } from '../../state/store.js';

const ROW = 28;
const LANE = 16;
const PAD = 12;
/** Beyond this many lanes the graph column stops growing (the rest is clipped). */
const MAX_LANES = 14;
/** Reference labels shown on a row; the others are counted. */
const MAX_LABELS = 2;

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
    ...g.top.map((e) => s('path', { d: path(e.from, e.to, 0, ROW / 2), stroke: laneColor(e.color), 'data-line': e.color, 'data-half': 'top' })),
    ...g.bottom.map((e) => s('path', { d: path(e.from, e.to, ROW / 2, ROW), stroke: laneColor(e.color), 'data-line': e.color, 'data-half': 'bottom' })),
  ];
  const cx = laneX(g.lane);
  const color = laneColor(g.color);
  const dot = row.parents.length > 1
    ? s('circle', { cx, cy: ROW / 2, r: 3.6, fill: 'var(--panel)', stroke: color, 'stroke-width': 2.2, 'data-line': g.color })
    : s('circle', { cx, cy: ROW / 2, r: 4.6, fill: color, 'data-line': g.color });
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
  const chip = (ref) => {
    const cls = ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'remote' : ref.isHead ? 'head' : '';
    const iconName = ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : ref.kind === 'head' ? 'commit' : null;
    return h('span', { class: `ref ${cls}`, style: { '--lane': color }, title: ref.name },
      iconName && icon(iconName, 12, 2),
      h('span', { class: 'ref-name' }, ref.kind === 'head' ? t('graph.detached') : ref.name),
      synced.has(ref.name) && icon('cloud', 12, 2));
  };
  // HEAD and local branches first. Two labels at most, then their number (one on a narrow window):
  // the message keeps room, and the hidden names are in the count's tooltip.
  const order = (ref) => (ref.kind === 'head' || ref.isHead ? 0 : { branch: 1, remote: 2, tag: 3 }[ref.kind] ?? 4);
  labels.sort((a, b) => order(a) - order(b));
  const more = (rest, cls) => rest.length > 0 && h('span', { class: `ref more ${cls}`, style: { '--lane': color }, title: rest.map((r) => r.name).join('\n') }, `+${rest.length}`);
  return labels.length > 0 && h('span', { class: 'refs' },
    labels.slice(0, MAX_LABELS).map((ref, i) => {
      const el = chip(ref);
      if (i > 0) el.classList.add('extra');
      return el;
    }),
    more(labels.slice(MAX_LABELS), 'wide'),
    more(labels.slice(1), 'narrow'));
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
    { label: t('rewrite.rewordMenu'), icon: 'edit', run: () => repoStore.rewordCommit(row.oid) },
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

/**
 * What the search found in the message and the author, wrapped in <mark>; null when the search does
 * not look there (commit id, files, code: the whole row is the match).
 */
function highlighter() {
  const q = search.active ? search.state.query : null;
  if (!q || !['all', 'message', 'author'].includes(q.scope)) return null;
  let re;
  try {
    re = new RegExp(q.regex ? q.text : q.text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), q.matchCase ? 'g' : 'gi');
  } catch {
    return null;
  }
  return (text, where) => {
    if (q.scope !== 'all' && q.scope !== where) return text;
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      parts.push(text.slice(last, m.index), h('mark', {}, m[0]));
      last = m.index + m[0].length;
    }
    if (!parts.length) return text;
    parts.push(text.slice(last));
    return parts;
  };
}

function commitRow(row, width, headOid, selected, mark) {
  const found = search.active ? (search.matches(row.oid) ? ' match' : ' dim') : '';
  return h('div', {
    class: `grow${selected ? ' selected' : ''}${row.parents.length > 1 ? ' merge' : ''}${found}`,
    dataset: { oid: row.oid },
    onclick: () => repoStore.selectCommit(row.oid),
    oncontextmenu: (event) => commitMenu(event, row, headOid),
  },
  laneSvg(row, width, row.oid === headOid),
  h('div', { class: 'msg' }, refLabels(row), h('span', { class: 'text', title: row.summary }, mark ? mark(row.summary, 'message') : row.summary),
    h('button', {
      type: 'button',
      class: 'row-act',
      title: t('graph.branchHere'),
      onclick: (event) => { event.stopPropagation(); repoStore.createBranch(row.oid); },
    }, icon('newBranch', 14, 2))),
  h('span', { class: 'author', title: row.email }, mark ? mark(row.author, 'author') : row.author),
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

  const mark = highlighter();

  container.style.setProperty('--graph-w', `${Math.max(width, 56)}px`);
  container.classList.toggle('only-matches', search.active && search.state.onlyMatches);
  mount(container,
    h('div', { class: 'graph-head' },
      h('span', {}, t('graph.graph')), h('span', {}, t('graph.message')), h('span', {}, t('graph.author')), h('span', {}, t('graph.date')), h('span', {}, t('graph.sha'))),
    dirty && wipRow(summary, Math.max(width, 56), headLane, selection === 'wip'),
    history.rows.length === 0 && !dirty && h('div', { class: 'graph-empty' }, t('graph.empty')),
    search.active && search.state.onlyMatches && search.state.result.oids.length === 0 && h('div', { class: 'graph-empty' }, t('search.none')),
    history.rows.map((row) => commitRow(row, Math.max(width, 56), headOid, selection === row.oid, mark)),
    history.hasMore && h('div', { class: 'load-more' },
      h('button', { type: 'button', class: 'btn', onclick: () => repoStore.loadMore() }, t('graph.loadMore'))),
  );
  container.scrollTop = scroll;
  lastHistory = history;
  focusLine(container);
}

/**
 * Every ancestor of a commit among the commits read so far, merged branches included: the dots and
 * the pieces of line that lead to them, by row: { dot, top, bottom } where top and bottom hold the
 * colours of the lines to bring forward.
 */
function ancestry(rows, start) {
  const index = new Map(rows.map((r, i) => [r.oid, i]));
  const marks = new Map();
  const mark = (i) => {
    if (!marks.has(i)) marks.set(i, { dot: false, top: new Set(), bottom: new Set() });
    return marks.get(i);
  };
  const seen = new Set([index.get(start)]);
  const queue = [index.get(start)];
  while (queue.length) {
    const i = queue.shift();
    const { graph, parents } = rows[i];
    // The first parent goes on in the commit's own line; each other parent in the line its merge
    // edge leads to, in the order of the parents.
    const merges = graph.bottom.filter((e) => e.from === graph.lane && e.to !== graph.lane);
    parents.forEach((parent, n) => {
      const j = index.get(parent);
      const color = n === 0 ? graph.color : merges[n - 1]?.color;
      if (j === undefined || color === undefined) return;
      mark(i).bottom.add(color);
      for (let k = i + 1; k < j; k += 1) {
        mark(k).top.add(color);
        mark(k).bottom.add(color);
      }
      mark(j).top.add(color);
      mark(j).dot = true;
      if (!seen.has(j)) {
        seen.add(j);
        queue.push(j);
      }
    });
  }
  return marks;
}

/**
 * Brings forward the line of history of the selected commit: the branch it belongs to, from its tip
 * down to where it leaves another line, and, less strongly, every commit it comes from (the branches
 * merged into its parent line included), not the rest of the lines they belong to. Its strokes get thicker, the other lines fade. Each line
 * has its own colour index, so its edges and dots are the ones carrying that index.
 */
function focusLine(container) {
  const { history, selection } = repoStore.state;
  const row = selection !== 'wip' && history?.rows.find((r) => r.oid === selection);
  const line = row ? String(row.graph.color) : null;
  container.classList.toggle('focus-line', line !== null);
  for (const el of container.querySelectorAll('.grow svg [data-line]')) {
    el.classList.toggle('on', el.dataset.line === line);
    el.classList.remove('src');
  }
  if (!row) return;
  const marks = ancestry(history.rows, row.oid);
  for (const [i, m] of marks) {
    const svg = container.querySelector(`.grow[data-oid="${history.rows[i].oid}"] svg`);
    if (!svg) continue;
    for (const el of svg.querySelectorAll('[data-line]')) {
      const color = Number(el.dataset.line);
      const half = el.dataset.half;
      const on = half ? m[half].has(color) : m.dot && color === history.rows[i].graph.color;
      if (on && el.dataset.line !== line) el.classList.add('src');
    }
  }
}

/** Selection changed: only the highlighted row changes, and the selected commit is scrolled into view. */
export function updateGraphSelection(container) {
  const { selection } = repoStore.state;
  for (const row of container.querySelectorAll('.grow.selected')) row.classList.remove('selected');
  const target = selection === 'wip' ? container.querySelector('.grow.wip') : container.querySelector(`.grow[data-oid="${selection}"]`);
  target?.classList.add('selected');
  target?.scrollIntoView({ block: 'nearest' });
  focusLine(container);
}

/** Brings a commit into the middle of the view, after a switch of branch. */
export function revealCommit(container, oid) {
  const row = oid && container.querySelector(`.grow[data-oid="${oid}"]`);
  if (!row) return;
  const top = row.offsetTop - container.clientHeight / 2 + row.offsetHeight / 2;
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1200);
}

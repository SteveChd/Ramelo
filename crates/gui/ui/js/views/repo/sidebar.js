// Branches of the repository: local ones (with what they have to push or pull), remote ones grouped
// by remote, and tags. A double click switches to a branch; a click shows its commit in the graph.

import { t } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { repoStore } from '../../state/repo-store.js';

/** Sections folded by the user, remembered while the application runs. */
const folded = new Set(['tags']);

function section(key, title, count, content, extra = null) {
  const open = !folded.has(key);
  return h('div', { class: 'sb-section' },
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
    open && content);
}

function trackInfo(branch) {
  if (branch.gone) return h('span', { class: 'gone', title: t('branch.goneHint') }, t('branch.gone'));
  if (!branch.ahead && !branch.behind) return null;
  return h('span', { class: 'track' },
    branch.ahead > 0 && h('span', { class: 'up' }, `↑${branch.ahead}`),
    branch.behind > 0 && h('span', { class: 'down' }, `↓${branch.behind}`));
}

function localItem(branch) {
  return h('div', {
    class: `sb-item${branch.isHead ? ' head' : ''}`,
    title: branch.upstream ? t('badge.tracking', { upstream: branch.upstream }) : branch.summary,
    onclick: () => repoStore.selectCommit(branch.oid),
    ondblclick: () => { if (!branch.isHead) repoStore.switchTo(branch.name); },
  },
  h('span', { class: 'lbl' }, branch.name),
  trackInfo(branch),
  h('span', { class: 'acts' },
    !branch.isHead && h('button', { type: 'button', class: 'icon-btn', title: t('branch.switch'), onclick: (e) => { e.stopPropagation(); repoStore.switchTo(branch.name); } }, icon('swap', 14)),
    h('button', { type: 'button', class: 'icon-btn', title: t('branch.newHere'), onclick: (e) => { e.stopPropagation(); repoStore.createBranch(branch.oid); } }, icon('plus', 14)),
    !branch.isHead && h('button', { type: 'button', class: 'icon-btn', title: t('branch.deleteTitle'), onclick: (e) => { e.stopPropagation(); repoStore.deleteBranch(branch.name); } }, icon('remove', 14))));
}

function remoteItem(branch) {
  const [, ...rest] = branch.name.split('/');
  return h('div', {
    class: 'sb-item nested',
    title: branch.summary,
    onclick: () => repoStore.selectCommit(branch.oid),
    ondblclick: () => repoStore.switchTo(branch.name),
  },
  h('span', { class: 'lbl' }, rest.join('/')),
  h('span', { class: 'acts' },
    h('button', { type: 'button', class: 'icon-btn', title: t('branch.checkoutRemote'), onclick: (e) => { e.stopPropagation(); repoStore.switchTo(branch.name); } }, icon('swap', 14))));
}

export function renderSidebar(container) {
  if (!container) return;
  const refs = repoStore.state.refs;
  if (!refs) {
    mount(container, h('div', { class: 'loading' }, t('repo.loading')));
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
  mount(container,
    section('local', t('branch.local'), local.length,
      local.length ? local.map(localItem) : h('div', { class: 'sb-empty' }, t('branch.noLocal')),
      h('button', { type: 'button', class: 'icon-btn small', title: t('repo.newBranch'), onclick: () => repoStore.createBranch() }, icon('plus', 14))),
    section('remote', t('branch.remote'), refs.remote.length,
      refs.remote.length
        ? sortedRemotes.map(([remote, branches]) => [
          h('div', { class: 'sb-group' }, icon('cloud', 13), remote),
          branches.sort((a, b) => a.name.localeCompare(b.name)).map(remoteItem),
        ])
        : h('div', { class: 'sb-empty' }, t('branch.noRemote'))),
    section('tags', t('branch.tags'), refs.tags.length,
      refs.tags.length
        ? refs.tags.map((tag) => h('div', { class: 'sb-item', onclick: () => repoStore.selectCommit(tag.oid) }, icon('tag', 13), h('span', { class: 'lbl' }, tag.name)))
        : h('div', { class: 'sb-empty' }, t('branch.noTags'))),
  );
}

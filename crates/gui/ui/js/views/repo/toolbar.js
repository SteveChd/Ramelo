// Toolbar of a repository: the current branch, then fetch, pull and push with what is waiting on
// each side, and a new branch.

import { t, tn } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { shortcut } from '../../app/actions.js';
import { openRepoMenu } from '../../components/repo-menu.js';
import { icon } from '../../lib/icons.js';
import { layout } from '../../state/layout.js';
import { repoStore } from '../../state/repo-store.js';
import { store } from '../../state/store.js';

function tool(name, iconName, label, { count = 0, title, disabled = false, onclick }) {
  const running = repoStore.state.running === name;
  return h('button', {
    type: 'button',
    class: `tool${running ? ' running' : ''}`,
    title: title ?? label,
    disabled: disabled || Boolean(repoStore.state.running),
    onclick,
  }, icon(running ? 'refresh' : iconName, 17), label, count > 0 && h('span', { class: 'count' }, count));
}

/** Shows or hides a side panel; pressed while the panel is shown. */
function panelToggle(key, iconName, action) {
  const key2 = shortcut(action);
  return h('button', {
    type: 'button',
    class: 'icon-btn toggle',
    'aria-pressed': String(!layout.state[key]),
    title: key2 ? `${t(`action.${action}`)} (${key2})` : t(`action.${action}`),
    onclick: () => layout.toggle(key),
  }, icon(iconName));
}

export function renderToolbar(container, repo) {
  const s = repo.summary;
  const branch = s?.head.branch;
  const hasRemote = Boolean(s?.remotes.length);
  mount(container,
    h('div', { class: 'current' },
      icon('branch', 16),
      h('span', { class: 'lbl' }, branch ?? t('badge.detached', { oid: (s?.head.oid ?? '').slice(0, 7) })),
      s?.upstream && h('span', { class: 'upstream' }, `→ ${s.upstream}`)),
    tool('fetch', 'fetch', t('repo.fetch'), {
      title: t('repo.fetchHint'),
      disabled: !hasRemote,
      onclick: () => repoStore.fetch(),
    }),
    tool('pull', 'pull', t('repo.pull'), {
      count: s?.behind,
      title: s?.behind ? tn('badge.behind', s.behind) : t('repo.pullHint'),
      disabled: !s?.upstream,
      onclick: () => repoStore.pull(),
    }),
    tool('push', 'push', t('repo.push'), {
      count: s?.ahead,
      title: !s?.upstream && branch ? t('repo.pushNew', { branch }) : s?.ahead ? tn('badge.ahead', s.ahead) : t('repo.pushHint'),
      disabled: !hasRemote || !branch,
      onclick: () => repoStore.push(),
    }),
    h('div', { class: 'vsep' }),
    tool('branch', 'newBranch', t('repo.newBranch'), { onclick: () => repoStore.createBranch() }),
    h('div', { class: 'spacer' }),
    h('button', { type: 'button', class: 'icon-btn', title: t('color.change'), onclick: (event) => openRepoMenu(event.currentTarget, repo) }, icon('palette')),
    h('button', { type: 'button', class: 'icon-btn', title: t('action.repo.openFolder'), onclick: () => store.openFolder(repo.path) }, icon('folder')),
    h('button', { type: 'button', class: 'icon-btn', title: t('action.repo.refresh'), onclick: () => store.refresh(repo.path) }, icon('refresh')),
    h('div', { class: 'vsep' }),
    panelToggle('leftCollapsed', 'panelLeft', 'view.toggleLeft'),
    panelToggle('rightCollapsed', 'panelRight', 'view.toggleRight'),
  );
}

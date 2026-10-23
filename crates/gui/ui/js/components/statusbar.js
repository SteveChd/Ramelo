// Status bar: number of repositories, what needs attention, last refresh and git version.

import { t, tn } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { clock } from '../lib/time.js';
import { store } from '../state/store.js';
import { needsSync, repoState } from './badges.js';

export function renderStatusbar(container) {
  const repos = store.repositories;
  const changed = repos.filter((r) => ['dirty', 'conflict'].includes(repoState(r))).length;
  const sync = repos.filter(needsSync).length;
  const unreadable = repos.filter((r) => r.error).length;
  const { refreshedAt, busy } = store.ui;
  mount(container,
    h('span', {}, tn('status.repos', repos.length)),
    changed > 0 && h('span', {}, tn('status.changed', changed)),
    sync > 0 && h('span', {}, tn('status.sync', sync)),
    unreadable > 0 && h('span', { class: 'git-missing' }, tn('status.unreadable', unreadable)),
    h('div', { class: 'spacer' }),
    busy > 0
      ? h('span', { class: 'spinning', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, icon('refresh', 13), t('status.reading'))
      : refreshedAt && h('span', {}, t('status.refreshed', { time: clock(refreshedAt) })),
  );
}

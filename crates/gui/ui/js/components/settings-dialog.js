// Settings of the application: how often the pull requests are read and the remotes fetched in the
// background, and whether new versions are looked for.

import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { FETCH_CHOICES, PULL_REFRESH_CHOICES, settings } from '../state/settings.js';
import { dialogHead, openDialog } from './dialog.js';

export function openSettingsDialog() {
  return openDialog((box, close) => {
    box.classList.add('medium', 'settings');
    const refresh = h('select', { class: 'select', 'aria-label': t('settings.pullRefresh') },
      PULL_REFRESH_CHOICES.map((m) => h('option', { value: String(m) }, m ? t('settings.everyMinutes', { n: m }) : t('settings.never'))));
    refresh.value = String(settings.state.pullRefreshMinutes);
    refresh.addEventListener('change', () => settings.set({ pullRefreshMinutes: Number(refresh.value) }));
    const fetching = h('select', { class: 'select', 'aria-label': t('settings.fetch') },
      FETCH_CHOICES.map((m) => h('option', { value: String(m) }, m ? t('settings.everyMinutes', { n: m }) : t('settings.fetchNever'))));
    fetching.value = String(settings.state.fetchMinutes);
    fetching.addEventListener('change', () => settings.set({ fetchMinutes: Number(fetching.value) }));
    const updates = h('input', { type: 'checkbox', checked: settings.state.checkUpdates });
    updates.addEventListener('change', () => settings.set({ checkUpdates: updates.checked }));
    mount(box,
      dialogHead(t('settings.title'), close),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('settings.pullRefresh')), refresh),
      h('p', { class: 'hint settings-hint' }, t('settings.pullRefreshHint')),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('settings.fetch')), fetching),
      h('p', { class: 'hint settings-hint' }, t('settings.fetchHint')),
      h('label', { class: 'check' }, updates, t('settings.checkUpdates')),
      h('p', { class: 'hint settings-hint' }, t('settings.checkUpdatesHint')),
      h('div', { class: 'dialog-foot' }, h('button', { type: 'button', class: 'btn primary', onclick: () => close(null) }, t('settings.done'))));
  });
}

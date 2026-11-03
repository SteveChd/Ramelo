// Settings of the application. For now: how often the pull requests are read in the background.

import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { PULL_REFRESH_CHOICES, settings } from '../state/settings.js';
import { dialogHead, openDialog } from './dialog.js';

export function openSettingsDialog() {
  return openDialog((box, close) => {
    box.classList.add('medium', 'settings');
    const refresh = h('select', { class: 'select', 'aria-label': t('settings.pullRefresh') },
      PULL_REFRESH_CHOICES.map((m) => h('option', { value: String(m) }, m ? t('settings.everyMinutes', { n: m }) : t('settings.never'))));
    refresh.value = String(settings.state.pullRefreshMinutes);
    refresh.addEventListener('change', () => settings.set({ pullRefreshMinutes: Number(refresh.value) }));
    mount(box,
      dialogHead(t('settings.title'), close),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('settings.pullRefresh')), refresh),
      h('p', { class: 'hint settings-hint' }, t('settings.pullRefreshHint')),
      h('div', { class: 'dialog-foot' }, h('button', { type: 'button', class: 'btn primary', onclick: () => close(null) }, t('settings.done'))));
  });
}

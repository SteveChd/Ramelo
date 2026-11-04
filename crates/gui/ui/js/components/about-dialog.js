// « About »: the name and version of the application, and what it runs on (git, the web view, the
// system), which can be copied to describe a problem.

import * as backend from '../api/backend.js';
import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { logo } from '../lib/icons.js';
import { store } from '../state/store.js';
import { dialogHead, openDialog } from './dialog.js';

const OS_NAMES = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };

export function openAboutDialog() {
  return openDialog((box, close) => {
    box.classList.add('medium', 'about');
    const facts = h('dl', { class: 'about-facts' }, h('div', { class: 'muted' }, t('repo.loading')));
    let text = '';
    mount(box,
      dialogHead(t('about.title'), close),
      h('div', { class: 'about-top' },
        logo('about-logo'),
        h('div', {},
          h('div', { class: 'about-name' }, 'Ramelo'),
          h('div', { class: 'about-tagline' }, t('about.tagline')),
          h('div', { class: 'about-version', 'data-version': '' }))),
      facts,
      h('div', { class: 'dialog-foot' },
        h('button', {
          type: 'button',
          class: 'btn',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(text);
              store.notify(t('about.copied'));
            } catch {
              store.notify(t('about.copyFailed'), true);
            }
          },
        }, t('about.copy')),
        h('button', { type: 'button', class: 'btn primary', onclick: () => close(null) }, t('settings.done'))));
    backend.about().then((info) => {
      box.querySelector('[data-version]').textContent = t('about.version', { version: info.version });
      const rows = [
        [t('about.git'), info.git ?? t('about.gitMissing')],
        [t('about.webview'), info.webview ?? '—'],
        ['Tauri', info.tauri],
        [t('about.system'), `${OS_NAMES[info.os] ?? info.os} (${info.arch})`],
        [t('about.dataDir'), h('button', { type: 'button', class: 'link-btn path', title: t('about.openDataDir'), onclick: () => backend.openFolder(info.dataDir).catch(() => {}) }, info.dataDir)],
        [t('about.author'), info.authors],
        [t('about.license'), info.license],
      ];
      mount(facts, rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
      text = [`Ramelo ${info.version}`, ...rows.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : info.dataDir}`)].join('\n');
    }).catch(() => mount(facts, h('div', { class: 'muted' }, t('about.unavailable'))));
  });
}

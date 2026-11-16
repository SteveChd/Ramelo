// A new version of Ramelo: what it brings, and the user's choice to install it now (download, install,
// restart), later, or never for this version. Where Ramelo cannot replace itself (Linux outside an
// AppImage), the button opens the page to download it.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { markdown } from '../lib/markdown.js';
import { day } from '../lib/time.js';
import { dialogHead, openDialog } from './dialog.js';

const MB = 1024 * 1024;
const size = (bytes) => (bytes / MB).toFixed(1);

/** Resolves with 'later', 'skip', or null; once the installation starts, the application restarts. */
export function openUpdateDialog(info) {
  let installing = false;
  return openDialog((box, close) => {
    box.classList.add('medium', 'update');
    const phase = h('span', { class: 'phase' });
    const detail = h('span', { class: 'detail' });
    const bar = h('div', { class: 'bar' });
    const progress = h('div', { class: 'clone-progress', hidden: true },
      h('div', { class: 'line' }, phase, detail),
      h('div', { class: 'track' }, bar));
    const error = h('p', { class: 'field-error' });
    const later = h('button', { type: 'button', class: 'btn', onclick: () => close('later') }, t('update.later'));
    const skip = h('button', { type: 'button', class: 'btn', onclick: () => close('skip') }, t('update.skip'));
    const install = h('button', { type: 'button', class: 'btn primary', autofocus: true },
      icon(info.canInstall ? 'pull' : 'export', 15), t(info.canInstall ? 'update.install' : 'update.download'));

    install.addEventListener('click', async () => {
      if (!info.canInstall) {
        backend.openUrl(info.page).catch(() => {});
        close('later');
        return;
      }
      installing = true;
      install.disabled = later.disabled = skip.disabled = true;
      error.textContent = '';
      progress.hidden = false;
      phase.textContent = t('update.downloading');
      bar.classList.add('busy');
      try {
        await backend.installUpdate(({ downloaded, total, installing: done }) => {
          if (done) {
            phase.textContent = t('update.installing');
            detail.textContent = '';
            bar.classList.add('busy');
            return;
          }
          if (total) {
            bar.classList.remove('busy');
            bar.style.width = `${Math.min(100, (downloaded / total) * 100)}%`;
            detail.textContent = t('update.size', { done: size(downloaded), total: size(total) });
          } else {
            detail.textContent = t('update.sizeUnknown', { done: size(downloaded) });
          }
        });
        // The application restarts on the new version; in the browser preview, nothing more happens.
        phase.textContent = t('update.restarting');
        installing = false;
      } catch (failure) {
        installing = false;
        install.disabled = later.disabled = skip.disabled = false;
        progress.hidden = true;
        error.textContent = describeError(failure);
      }
    });

    const published = info.date ? ` ${t('update.published', { date: day(info.date) })}` : '';
    mount(box,
      dialogHead(t('update.title'), close),
      h('p', { class: 'dialog-text' }, t('update.available', { version: info.version, current: info.current }) + published),
      info.notes && h('div', { class: 'update-notes' }, markdown(info.notes)),
      !info.canInstall && h('p', { class: 'hint' }, t('update.manual')),
      progress,
      error,
      h('div', { class: 'dialog-foot' }, skip, h('span', { class: 'foot-gap' }), later, install));
  }, () => !installing);
}

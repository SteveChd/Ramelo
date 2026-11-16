// Looks for a new version of Ramelo: a while after the start, then every few hours, unless turned off
// in the settings, and on demand from the Help menu. A version the user chose to skip is not offered
// again on its own.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { openUpdateDialog } from '../components/update-dialog.js';
import { t } from '../i18n/i18n.js';
import { settings } from './settings.js';
import { store } from './store.js';

const SKIPPED_KEY = 'ramelo.skippedVersion';
const FIRST_CHECK = 20 * 1000;
const EVERY = 6 * 60 * 60 * 1000;

let open = false;

function skipped() {
  try { return localStorage.getItem(SKIPPED_KEY); } catch { return null; }
}

async function offer(info) {
  open = true;
  const answer = await openUpdateDialog(info);
  open = false;
  if (answer === 'skip') {
    try { localStorage.setItem(SKIPPED_KEY, info.version); } catch { /* offered again next time */ }
  }
}

async function automatic() {
  if (!settings.state.checkUpdates || open) return;
  // Offline, or the service does not answer: nothing to say, the next check will try again.
  const info = await backend.checkUpdate().catch(() => null);
  if (info && info.version !== skipped()) await offer(info);
}

/** From the Help menu: always answers, and offers even a version skipped before. */
export async function checkForUpdates() {
  if (open) return;
  try {
    const info = await backend.checkUpdate();
    if (info) {
      await offer(info);
    } else {
      const { version } = await backend.about();
      store.notify(t('update.upToDate', { version }));
    }
  } catch (error) {
    store.notify(describeError(error), true);
  }
}

export function startUpdateChecks() {
  setTimeout(automatic, FIRST_CHECK);
  setInterval(automatic, EVERY);
}

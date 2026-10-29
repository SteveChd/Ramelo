// The first connection to a server over ssh: ssh asks in a terminal whether to trust the server,
// which git started by Ramelo cannot answer. The keys of the server are shown here with their
// fingerprints, to compare with those the service publishes; once trusted, the command runs again.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { dialogHead, openDialog } from './dialog.js';

/** Asks whether to trust `host`; true once its keys are in the known hosts. */
export function askHostTrust(host) {
  let busy = false;
  return openDialog((box, close) => {
    box.classList.add('medium', 'host-trust');
    const body = h('div', { class: 'host-keys' }, h('p', { class: 'dialog-text' }, t('ssh.reading')));
    const error = h('div', { class: 'field-error' });
    const trust = h('button', { type: 'button', class: 'btn primary', disabled: true }, icon('check', 15), t('ssh.trust'));
    let keys = [];
    trust.addEventListener('click', async () => {
      busy = true;
      trust.disabled = true;
      error.textContent = '';
      try {
        await backend.trustSshHost(host, keys.map((k) => k.fingerprint));
        close(true);
      } catch (failure) {
        busy = false;
        trust.disabled = false;
        error.textContent = describeError(failure);
      }
    });
    mount(box,
      dialogHead(t('ssh.title', { host }), close),
      h('p', { class: 'dialog-text' }, t('ssh.text', { host })),
      body,
      h('p', { class: 'hint' }, t('ssh.check')),
      error,
      h('div', { class: 'dialog-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, t('dialog.cancel')),
        trust));
    backend.sshHostKeys(host).then((found) => {
      keys = found;
      mount(body, h('ul', {}, keys.map((k) => h('li', {}, h('span', { class: 'kind' }, k.kind), h('code', {}, k.fingerprint)))));
      trust.disabled = false;
      trust.focus();
    }, (failure) => {
      mount(body);
      error.textContent = describeError(failure);
    });
  }, () => !busy).then((answer) => answer === true);
}

/**
 * Runs `call`; when it fails on a server ssh does not know, offers to trust it and runs it again.
 * Any other failure, or a refusal, is passed on.
 */
export async function withHostTrust(call) {
  try {
    return await call();
  } catch (failure) {
    if (failure?.code !== 'host_unknown' || !failure.subject) throw failure;
    if (!(await askHostTrust(failure.subject))) throw failure;
    return call();
  }
}

// Accounts on hosting services: the list, each one checked or removed, and a form to add one with its
// token. Tokens are checked with the service before they are kept, in the system's credential store.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { accounts, PROVIDERS } from '../state/accounts.js';
import { confirm, dialogHead, openDialog } from './dialog.js';

/** Mark of a service: its initials in its colour. */
export function providerMark(provider, size = '') {
  return h('span', { class: `provider-mark ${provider} ${size}`, 'aria-hidden': 'true' }, t(`accounts.mark.${provider}`));
}

function accountRow(account, redraw) {
  const status = h('span', { class: 'account-status' });
  const check = async (button) => {
    button.disabled = true;
    status.className = 'account-status busy';
    status.textContent = t('accounts.checking');
    try {
      await accounts.check(account.id);
      status.className = 'account-status ok';
      status.replaceChildren(icon('check', 13, 2.4), t('accounts.valid'));
    } catch (error) {
      status.className = 'account-status bad';
      status.textContent = describeError(error);
    } finally {
      button.disabled = false;
    }
  };
  const remove = async () => {
    const ok = await confirm({
      title: t('accounts.removeTitle', { name: account.username }),
      message: t('accounts.removeText', { service: t(`accounts.provider.${account.provider}`) }),
      confirmLabel: t('accounts.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await accounts.remove(account.id);
    } catch (error) {
      status.className = 'account-status bad';
      status.textContent = describeError(error);
      return;
    }
    redraw();
  };
  const checkButton = h('button', { type: 'button', class: 'btn', onclick: (event) => check(event.currentTarget) }, t('accounts.check'));
  return h('li', { class: 'account' },
    providerMark(account.provider),
    h('div', { class: 'account-who' },
      h('span', { class: 'account-name' }, account.name ? h('span', {}, account.name, h('span', { class: 'login' }, ` @${account.username}`)) : account.username),
      h('span', { class: 'account-where' }, `${t(`accounts.provider.${account.provider}`)} · ${account.url.replace(/^https?:\/\//, '')}`),
      status),
    h('div', { class: 'account-actions' },
      checkButton,
      h('button', { type: 'button', class: 'icon-btn', title: t('accounts.remove'), onclick: remove }, icon('remove', 16))));
}

function listView(box, close, showForm) {
  const redraw = () => listView(box, close, showForm);
  const list = accounts.list;
  mount(box,
    dialogHead(t('accounts.title'), close),
    h('p', { class: 'dialog-text' }, t('accounts.intro')),
    list.length
      ? h('ul', { class: 'accounts' }, list.map((a) => accountRow(a, redraw)))
      : h('div', { class: 'accounts-empty' }, t('accounts.none')),
    h('div', { class: 'dialog-foot' },
      h('span', { class: 'hint' }, icon('lock', 13), t('accounts.storeHint')),
      h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.close')),
      h('button', { type: 'button', class: 'btn primary', autofocus: true, onclick: () => showForm() }, icon('plus', 15), t('accounts.add'))));
  (box.querySelector('[autofocus]'))?.focus();
}

function formView(box, close, back, state) {
  let provider = state.provider ?? 'github';
  const info = () => PROVIDERS.find((p) => p.id === provider);
  const url = h('input', { type: 'text', spellcheck: 'false', value: state.url ?? '' });
  const login = h('input', { type: 'email', spellcheck: 'false', value: state.login ?? '', placeholder: t('accounts.loginPlaceholder') });
  const token = h('input', { type: 'password', spellcheck: 'false', autocomplete: 'off', autofocus: true });
  const error = h('div', { class: 'field-error' });
  const submit = h('button', { type: 'button', class: 'btn primary' }, icon('check', 15), t('accounts.connect'));
  const tokenHelp = h('div', { class: 'token-help' });
  const urlField = h('label', { class: 'field' }, h('span', { class: 'label' }, t('accounts.url')), url, h('span', { class: 'hint' }, ''));
  const loginField = h('label', { class: 'field' }, h('span', { class: 'label' }, t('accounts.login')), login);
  let busy = false;

  const tabs = h('div', { class: 'seg provider-seg', role: 'group', 'aria-label': t('accounts.service') },
    PROVIDERS.map((p) => h('button', {
      type: 'button',
      'data-provider': p.id,
      onclick: () => { provider = p.id; update(); token.focus(); },
    }, providerMark(p.id, 'small'), t(`accounts.provider.${p.id}`))));

  const update = () => {
    const p = info();
    for (const button of tabs.children) button.setAttribute('aria-pressed', String(button.dataset.provider === provider));
    urlField.hidden = Boolean(p.fixed);
    url.placeholder = p.defaultUrl ?? 'https://bitbucket.example.com';
    urlField.querySelector('.hint').textContent = t(p.defaultUrl ? 'accounts.urlHint' : 'accounts.urlRequired');
    loginField.hidden = !p.login;
    mount(tokenHelp,
      h('span', {}, t(`accounts.scopes.${provider}`)),
      ' ',
      h('button', { type: 'button', class: 'link', onclick: openTokenPage }, t('accounts.createToken'), icon('external', 12)));
    error.textContent = '';
  };

  async function openTokenPage() {
    try {
      await backend.openUrl(await backend.tokenPage(provider, url.value.trim()));
    } catch (failure) {
      error.textContent = describeError(failure);
    }
  }

  const run = async () => {
    if (busy) return;
    busy = true;
    submit.disabled = true;
    submit.replaceChildren(h('span', { class: 'spinner' }), t('accounts.connecting'));
    error.textContent = '';
    try {
      await accounts.add({ provider, url: info().fixed ? '' : url.value, login: info().login ? login.value : null, token: token.value });
      back();
    } catch (failure) {
      error.textContent = describeError(failure);
      busy = false;
      submit.disabled = false;
      submit.replaceChildren(icon('check', 15), t('accounts.connect'));
    }
  };
  submit.addEventListener('click', run);
  for (const input of [url, login, token]) input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });

  mount(box,
    dialogHead(t('accounts.addTitle'), close),
    h('div', { class: 'field' }, h('span', { class: 'label' }, t('accounts.service')), tabs),
    urlField,
    loginField,
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('accounts.token')), token),
    tokenHelp,
    error,
    h('div', { class: 'dialog-foot' },
      h('button', { type: 'button', class: 'btn', onclick: () => back() }, t('accounts.back')),
      submit));
  update();
  token.focus();
}

/** The accounts dialog; `add`: opens straight on the form to add one. */
export async function openAccountsDialog({ add = false } = {}) {
  await accounts.load();
  return openDialog((box, close) => {
    box.classList.add('medium', 'accounts-dialog');
    const showList = () => listView(box, close, showForm);
    const showForm = () => formView(box, close, showList, {});
    if (add) showForm(); else showList();
  });
}

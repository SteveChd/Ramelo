// Finding a repository on an account (GitHub, GitLab, Bitbucket) to clone it: a search on the left,
// the README of the selected repository on the right, then its address goes to the clone dialog.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { relativeTime } from '../lib/time.js';
import { accounts } from '../state/accounts.js';
import { documentHtml } from '../views/repo/preview.js';
import { openAccountsDialog, providerMark } from './accounts-dialog.js';
import { dialogHead, openDialog } from './dialog.js';

const PREFS_KEY = 'ramelo.finder';

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered: the defaults come back next time.
  }
}

const isMarkdown = (name) => /\.(md|markdown|mdown)$/i.test(name);

/** Resolves with { address } of the repository to clone, or null. */
export async function openRepoFinder() {
  await accounts.load();
  return openDialog((box, close) => {
    box.classList.add('wide', 'finder');
    const prefs = { scope: 'mine', protocol: 'https', ...loadPrefs() };
    let account = accounts.list.find((a) => a.id === prefs.account) ?? accounts.list[0] ?? null;
    let results = [];
    let selected = null;
    let searching = 0;
    let timer = null;
    const readmes = new Map();

    const field = h('input', { type: 'search', class: 'finder-search', autofocus: true, spellcheck: 'false', placeholder: t('finder.search') });
    const list = h('div', { class: 'finder-list', role: 'listbox', tabindex: '-1' });
    const preview = h('div', { class: 'finder-preview' });
    const status = h('div', { class: 'finder-status' });

    const remember = () => savePrefs({ account: account?.id, scope: prefs.scope, protocol: prefs.protocol });

    const accountPicker = () => {
      if (accounts.list.length <= 1) {
        return account && h('div', { class: 'finder-account single' }, providerMark(account.provider, 'small'), account.username);
      }
      const select = h('select', { class: 'finder-account', 'aria-label': t('finder.account'), onchange: () => {
        account = accounts.list.find((a) => a.id === select.value);
        remember();
        draw();
        search();
      } }, accounts.list.map((a) => h('option', { value: a.id, selected: a.id === account?.id },
        `${a.username} · ${t(`accounts.provider.${a.provider}`)} · ${a.url.replace(/^https?:\/\//, '')}`)));
      return select;
    };

    const scopeSwitch = () => {
      // Bitbucket Cloud has no search beyond the user's own repositories.
      if (account?.provider === 'bitbucket') return null;
      return h('div', { class: 'seg', role: 'group', 'aria-label': t('finder.scope') },
        ['mine', 'all'].map((scope) => h('button', {
          type: 'button',
          'aria-pressed': String(prefs.scope === scope),
          onclick: () => { prefs.scope = scope; remember(); draw(); search(); },
        }, t(`finder.scope.${scope}`))));
    };

    const row = (repo) => h('div', {
      class: `finder-row${selected?.key === repo.key ? ' selected' : ''}`,
      role: 'option',
      'aria-selected': String(selected?.key === repo.key),
      onclick: () => choose(repo),
      ondblclick: () => cloneIt(repo),
    },
    h('div', { class: 'finder-name' },
      h('span', { class: 'full' }, repo.fullName),
      repo.private && h('span', { class: 'tag', title: t('finder.private') }, icon('lock', 12)),
      repo.fork && h('span', { class: 'tag' }, t('finder.fork'))),
    repo.description && h('div', { class: 'finder-desc' }, repo.description),
    h('div', { class: 'finder-meta' },
      repo.language && h('span', {}, repo.language),
      repo.stars ? h('span', {}, `★ ${repo.stars}`) : null,
      repo.updated && h('span', {}, t('finder.updated', { when: relativeTime(repo.updated) }))));

    const drawList = () => {
      if (searching && results.length === 0) mount(list, h('div', { class: 'finder-note' }, h('span', { class: 'spinner' }), t('finder.searching')));
      else if (results.length === 0) mount(list, h('div', { class: 'finder-note' }, t(field.value.trim() ? 'finder.noMatch' : 'finder.none')));
      else mount(list, results.map(row));
      list.classList.toggle('busy', searching > 0);
    };

    const cloneAddress = (repo) => (prefs.protocol === 'ssh' ? repo.cloneSsh ?? repo.cloneHttps : repo.cloneHttps ?? repo.cloneSsh);

    const cloneIt = (repo) => {
      const address = cloneAddress(repo);
      if (address) close({ address });
    };

    const drawPreview = () => {
      if (!selected) {
        mount(preview, h('div', { class: 'finder-note' }, t('finder.pick')));
        return;
      }
      const repo = selected;
      const readme = readmes.get(repo.key);
      const protocols = repo.cloneHttps && repo.cloneSsh && h('div', { class: 'seg', role: 'group', 'aria-label': t('finder.protocol') },
        ['https', 'ssh'].map((p) => h('button', {
          type: 'button',
          'aria-pressed': String(prefs.protocol === p),
          onclick: () => { prefs.protocol = p; remember(); drawPreview(); },
        }, p.toUpperCase())));
      let body;
      if (!readme || readme.loading) body = h('div', { class: 'finder-note' }, h('span', { class: 'spinner' }), t('finder.readmeLoading'));
      else if (readme.error) body = h('div', { class: 'finder-note error' }, describeError(readme.error));
      else if (!readme.file) body = h('div', { class: 'finder-note' }, t('finder.noReadme'));
      else if (isMarkdown(readme.file.name)) body = h('iframe', { class: 'doc-frame', sandbox: '', referrerpolicy: 'no-referrer', title: readme.file.name, srcdoc: documentHtml('markdown', readme.file.text) });
      else body = h('pre', { class: 'finder-plain' }, readme.file.text);
      mount(preview,
        h('div', { class: 'finder-head' },
          h('div', { class: 'finder-title' },
            h('h3', {}, repo.fullName),
            repo.description && h('p', {}, repo.description),
            h('div', { class: 'finder-address' }, h('code', {}, cloneAddress(repo) ?? ''))),
          h('div', { class: 'finder-actions' },
            protocols,
            repo.webUrl && h('button', { type: 'button', class: 'btn', title: repo.webUrl, onclick: () => backend.openUrl(repo.webUrl) }, icon('external', 14), t('finder.open')),
            h('button', { type: 'button', class: 'btn primary', disabled: !cloneAddress(repo), onclick: () => cloneIt(repo) }, icon('fetch', 15), t('finder.clone')))),
        readme?.file && h('div', { class: 'finder-readme-name' }, readme.file.name),
        body);
    };

    const choose = async (repo) => {
      selected = repo;
      drawList();
      list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
      if (!readmes.has(repo.key)) {
        readmes.set(repo.key, { loading: true });
        try {
          readmes.set(repo.key, { file: await backend.repositoryReadme(account.id, repo) });
        } catch (error) {
          readmes.set(repo.key, { error });
        }
      }
      if (selected?.key === repo.key) drawPreview();
    };

    async function search() {
      if (!account) return;
      const id = (searching += 1);
      status.textContent = '';
      drawList();
      try {
        const found = await backend.searchRepositories(account.id, field.value, account.provider === 'bitbucket' ? 'mine' : prefs.scope);
        if (id !== searching) return;
        results = found;
        if (!results.some((r) => r.key === selected?.key)) selected = null;
        status.textContent = '';
      } catch (error) {
        if (id !== searching) return;
        results = [];
        status.textContent = describeError(error);
      }
      searching = 0;
      drawList();
      if (!selected && results[0]) choose(results[0]);
      else drawPreview();
    }

    field.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(search, 350);
    });
    field.addEventListener('keydown', (event) => {
      const index = results.findIndex((r) => r.key === selected?.key);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = results[Math.max(0, Math.min(results.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        if (next) choose(next);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (timer) { clearTimeout(timer); timer = null; search(); } else if (selected) cloneIt(selected);
      }
    });

    const addAccount = async () => {
      await openAccountsDialog({ add: true });
      account = accounts.list[0] ?? null;
      draw();
      search();
    };

    function draw() {
      if (!account) {
        mount(box,
          dialogHead(t('finder.title'), close),
          h('div', { class: 'finder-empty' },
            icon('user', 30),
            h('p', {}, t('finder.noAccount')),
            h('button', { type: 'button', class: 'btn primary', onclick: addAccount }, icon('plus', 15), t('accounts.add'))));
        return;
      }
      mount(box,
        dialogHead(t('finder.title'), close),
        h('div', { class: 'finder-bar' }, accountPicker(), field, scopeSwitch()),
        status,
        h('div', { class: 'finder-body' }, list, preview));
      drawList();
      drawPreview();
      field.focus();
    }

    draw();
    search();
  });
}

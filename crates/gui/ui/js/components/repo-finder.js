// Finding repositories on an account (GitHub, GitLab, Bitbucket) to clone them: a search on the left,
// the README of the selected repository on the right, then its address goes to the clone dialog.
// Several can be ticked, across searches, and cloned together.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { t, tn } from '../i18n/i18n.js';
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

/**
 * Resolves with { address } of the repository to clone, { addresses } of the repositories ticked to
 * clone together, or null.
 */
export async function openRepoFinder() {
  await accounts.load();
  return openDialog((box, close) => {
    box.classList.add('wide', 'finder');
    const prefs = { scope: 'mine', protocol: 'https', ...loadPrefs() };
    let account = accounts.list.find((a) => a.id === prefs.account) ?? accounts.list[0] ?? null;
    let results = [];
    let selected = null;
    /** key → repository: those ticked, kept from one search to the next. */
    const picked = new Map();
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

    const toggle = (repo) => {
      if (picked.has(repo.key)) picked.delete(repo.key);
      else if (cloneAddress(repo)) picked.set(repo.key, repo);
      drawList();
      drawFoot();
    };

    const row = (repo) => h('div', {
      class: `finder-row${selected?.key === repo.key ? ' selected' : ''}${picked.has(repo.key) ? ' picked' : ''}`,
      role: 'option',
      'aria-selected': String(selected?.key === repo.key),
      // Ctrl+click ticks, as in a list of files.
      onclick: (event) => (event.ctrlKey || event.metaKey ? toggle(repo) : choose(repo)),
      ondblclick: () => cloneIt(repo),
    },
    h('input', {
      type: 'checkbox',
      class: 'finder-pick',
      title: t('finder.tick'),
      'aria-label': t('finder.tick'),
      checked: picked.has(repo.key),
      disabled: !cloneAddress(repo),
      onclick: (event) => {
        event.stopPropagation();
        toggle(repo);
      },
      ondblclick: (event) => event.stopPropagation(),
    }),
    h('div', { class: 'finder-info' },
    h('div', { class: 'finder-name' },
      h('span', { class: 'full' }, repo.fullName),
      repo.private && h('span', { class: 'tag', title: t('finder.private') }, icon('lock', 12)),
      repo.fork && h('span', { class: 'tag' }, t('finder.fork'))),
    repo.description && h('div', { class: 'finder-desc' }, repo.description),
    h('div', { class: 'finder-meta' },
      repo.language && h('span', {}, repo.language),
      repo.stars ? h('span', {}, `★ ${repo.stars}`) : null,
      repo.updated && h('span', {}, t('finder.updated', { when: relativeTime(repo.updated) })))));

    const foot = h('div', { class: 'finder-foot' });
    const drawFoot = () => {
      if (picked.size === 0) {
        mount(foot, h('span', { class: 'hint' }, t('finder.tickHint')));
        return;
      }
      mount(foot,
        h('span', { class: 'finder-picked' }, tn('finder.picked', picked.size)),
        h('button', { type: 'button', class: 'link', onclick: () => { picked.clear(); drawList(); drawFoot(); } }, t('finder.untick')),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn primary', onclick: cloneTicked }, icon('fetch', 15), tn('finder.cloneTicked', picked.size)));
    };

    const cloneTicked = () => {
      const addresses = [...picked.values()].map(cloneAddress).filter(Boolean);
      if (addresses.length === 1) close({ address: addresses[0] });
      else if (addresses.length) close({ addresses });
    };

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
      } else if (event.key === ' ' && event.ctrlKey && selected) {
        event.preventDefault();
        toggle(selected);
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
        h('div', { class: 'finder-body' }, list, preview),
        foot);
      drawList();
      drawFoot();
      drawPreview();
      field.focus();
    }

    draw();
    search();
  });
}

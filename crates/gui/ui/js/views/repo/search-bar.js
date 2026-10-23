// Search bar above the graph (Ctrl+F): the text, where to look for it, case and regular expression,
// the number of matches and the arrows to go from one to the next.
//
// Built once; typing only updates the counter and the buttons, so the field never loses focus.

import { shortcut } from '../../app/actions.js';
import { t, tn } from '../../i18n/i18n.js';
import { h, mount } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { SCOPES, search } from '../../state/search.js';

let parts = null;

function toggle(name, label, title) {
  return h('button', { type: 'button', class: 'opt', title, 'aria-pressed': 'false', onclick: () => search.set({ [name]: !search.state[name] }) }, label);
}

function build() {
  const input = h('input', {
    type: 'search',
    spellcheck: 'false',
    oninput: (e) => search.set({ text: e.target.value }),
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) search.prev(); else search.next(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); search.close(); }
    },
  });
  const scope = h('select', { onchange: (e) => search.set({ scope: e.target.value }) });
  const caseBtn = toggle('matchCase', 'Aa');
  const regexBtn = toggle('regex', '.*');
  const onlyBtn = h('button', { type: 'button', class: 'opt wide', 'aria-pressed': 'false', onclick: () => search.set({ onlyMatches: !search.state.onlyMatches }) });
  const count = h('span', { class: 'count' });
  const prev = h('button', { type: 'button', class: 'icon-btn', onclick: () => search.prev() }, icon('arrowUp', 15));
  const next = h('button', { type: 'button', class: 'icon-btn', onclick: () => search.next() }, icon('arrowDown', 15));
  const close = h('button', { type: 'button', class: 'icon-btn', onclick: () => search.close() }, icon('close', 15));
  const el = h('div', { class: 'search-bar', role: 'search' },
    h('label', { class: 'query' }, icon('search', 15), input),
    scope, caseBtn, regexBtn, onlyBtn, count, prev, next, close);
  parts = { el, input, scope, caseBtn, regexBtn, onlyBtn, count, prev, next, close };
}

/** Texts, options and counter from the search state. */
function update() {
  const s = search.state;
  const p = parts;
  if (p.input.value !== s.text) p.input.value = s.text;
  p.input.placeholder = t(`search.placeholder.${s.scope}`);
  mount(p.scope, SCOPES.map((name) => h('option', { value: name, selected: s.scope === name }, t(`search.scope.${name}`))));
  p.scope.title = t('search.scopeHint');
  p.caseBtn.setAttribute('aria-pressed', String(s.matchCase));
  p.caseBtn.title = t('search.matchCase');
  p.regexBtn.setAttribute('aria-pressed', String(s.regex));
  p.regexBtn.title = t('search.regex');
  p.regexBtn.disabled = ['sha', 'file'].includes(s.scope);
  p.onlyBtn.setAttribute('aria-pressed', String(s.onlyMatches));
  p.onlyBtn.textContent = t('search.onlyMatches');
  p.onlyBtn.title = t('search.onlyMatchesHint');
  const total = s.result?.oids.length ?? 0;
  p.count.classList.toggle('error', Boolean(s.error));
  p.count.classList.toggle('none', Boolean(s.result) && total === 0);
  p.count.textContent = s.error ?? (s.running ? t('search.running')
    : !s.result ? ''
      : total === 0 ? t('search.none')
        : `${s.index + 1} / ${total}${s.result.truncated ? '+' : ''}`);
  p.count.title = s.result && total > 0 ? tn('search.count', total) : '';
  p.prev.disabled = total === 0;
  p.next.disabled = total === 0;
  const key = (action) => (shortcut(action) ? ` (${shortcut(action)})` : '');
  p.prev.title = `${t('search.prev')} (Shift+Enter)`;
  p.next.title = `${t('search.next')} (Enter)`;
  p.close.title = `${t('search.close')} (Esc)`;
  p.input.title = `${t('action.repo.search')}${key('repo.search')}`;
}

/** The bar, shown while a search is open; it takes the focus when the search was just opened. */
export function renderSearchBar(container) {
  if (!parts) build();
  container.hidden = !search.state.open;
  if (!search.state.open) return;
  if (container.firstChild !== parts.el) mount(container, parts.el);
  update();
  if (search.state.focus) {
    search.state.focus = false;
    parts.input.focus();
    parts.input.select();
  }
}


// Modal dialogs: a question with a few choices, or a field to fill. Each returns a promise with the
// user's answer (null when cancelled with Escape, the close button or a click outside).

import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

function open(build) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    let done = false;
    const close = (answer) => {
      if (done) return;
      done = true;
      backdrop.remove();
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(null);
      }
    };
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' });
    const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === backdrop) close(null); } }, box);
    build(box, close);
    document.body.append(backdrop);
    window.addEventListener('keydown', onKey, true);
    (box.querySelector('[autofocus]') ?? box.querySelector('.btn.primary, .btn'))?.focus();
  });
}

function head(title, close) {
  return h('div', { class: 'dialog-head' },
    h('h2', {}, title),
    h('button', { type: 'button', class: 'icon-btn', title: t('dialog.cancel'), onclick: () => close(null) }, icon('close', 16)));
}

/**
 * A question with choices: `choices` is a list of { value, label, hint?, primary?, danger? }.
 * Resolves with the value of the chosen one.
 */
export function choose({ title, message, choices }) {
  return open((box, close) => {
    mount(box,
      head(title, close),
      message && h('p', { class: 'dialog-text' }, message),
      h('div', { class: 'choices' }, choices.map((choice) => h('button', {
        type: 'button',
        class: `choice${choice.primary ? ' primary' : ''}${choice.danger ? ' danger' : ''}`,
        onclick: () => close(choice.value),
      }, h('span', { class: 'lbl' }, choice.label), choice.hint && h('span', { class: 'hint' }, choice.hint)))),
      h('div', { class: 'dialog-foot' }, h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.cancel'))),
    );
  });
}

/** Yes / no question; `danger` colours the confirm button for what cannot be undone. */
export function confirm({ title, message, confirmLabel, danger = false }) {
  return open((box, close) => {
    mount(box,
      head(title, close),
      h('p', { class: 'dialog-text' }, message),
      h('div', { class: 'dialog-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, t('dialog.cancel')),
        h('button', { type: 'button', class: `btn ${danger ? 'danger-fill' : 'primary'}`, autofocus: true, onclick: () => close(true) }, confirmLabel)),
    );
  }).then((answer) => answer === true);
}

/**
 * A text field, with optional check boxes: `checks` is a list of { key, label, checked }.
 * Resolves with { value, checks: { key: bool } }; `validate(value)` returns an error text or null.
 */
export function prompt({ title, message, label, value = '', placeholder = '', confirmLabel, checks = [], validate = () => null }) {
  return open((box, close) => {
    const error = h('div', { class: 'field-error' });
    const input = h('input', { type: 'text', value, placeholder, autofocus: true, spellcheck: 'false' });
    const boxes = checks.map((c) => ({ key: c.key, el: h('input', { type: 'checkbox', checked: c.checked }) }));
    const submit = () => {
      const problem = validate(input.value);
      error.textContent = problem ?? '';
      if (problem) return;
      close({ value: input.value, checks: Object.fromEntries(boxes.map((b) => [b.key, b.el.checked])) });
    };
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
    input.addEventListener('input', () => { error.textContent = ''; });
    mount(box,
      head(title, close),
      message && h('p', { class: 'dialog-text' }, message),
      h('label', { class: 'field' }, h('span', { class: 'label' }, label), input),
      error,
      boxes.map((b, i) => h('label', { class: 'check' }, b.el, checks[i].label)),
      h('div', { class: 'dialog-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.cancel')),
        h('button', { type: 'button', class: 'btn primary', onclick: submit }, confirmLabel)),
    );
    setTimeout(() => input.select(), 0);
  });
}

// Modal dialogs: a question with a few choices, or a field to fill. Each returns a promise with the
// user's answer (null when cancelled with Escape, the close button or a click outside).

import { t } from '../i18n/i18n.js';
import { h, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

/**
 * Opens a dialog drawn by `build(box, close)`. `guard()`, when given, can refuse closing it with
 * Escape or a click outside (while something runs).
 */
export function openDialog(build, guard = () => true) {
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
      // With a dialog opened from another one, Escape closes only the one on top.
      if (event.key === 'Escape' && [...document.querySelectorAll('.backdrop')].pop() === backdrop) {
        event.preventDefault();
        event.stopPropagation();
        if (guard()) close(null);
      }
    };
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' });
    const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === backdrop && guard()) close(null); } }, box);
    build(box, close);
    document.body.append(backdrop);
    window.addEventListener('keydown', onKey, true);
    (box.querySelector('[autofocus]') ?? box.querySelector('.btn.primary, .btn'))?.focus();
  });
}

const open = openDialog;

export function dialogHead(title, close) {
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
      dialogHead(title, close),
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
      dialogHead(title, close),
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
      dialogHead(title, close),
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

/**
 * A text to edit in a large field (a commit message, the content of a file). `notes` are short texts
 * shown above the field, `warning` one shown in its colour. Ctrl+Enter confirms. Resolves with the
 * text, or null.
 */
export function editText({ title, notes = [], warning = null, value = '', code = false, confirmLabel, validate = () => null }) {
  return open((box, close) => {
    box.classList.add(code ? 'wide' : 'medium');
    const error = h('div', { class: 'field-error' });
    const area = h('textarea', { class: `edit-area${code ? ' code' : ''}`, spellcheck: code ? 'false' : 'true', autofocus: true, wrap: code ? 'off' : 'soft' });
    area.value = value;
    const submit = () => {
      const problem = validate(area.value);
      error.textContent = problem ?? '';
      if (!problem) close(area.value);
    };
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit();
      }
      // In code, Tab indents instead of leaving the field.
      if (code && event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault();
        area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
      }
    });
    area.addEventListener('input', () => { error.textContent = ''; });
    mount(box,
      dialogHead(title, close),
      notes.filter(Boolean).map((note) => h('p', { class: 'dialog-text' }, note)),
      warning && h('p', { class: 'dialog-warning' }, icon('warning', 16), h('span', {}, warning)),
      area,
      error,
      h('div', { class: 'dialog-foot' },
        h('span', { class: 'hint' }, 'Ctrl+Enter'),
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('dialog.cancel')),
        h('button', { type: 'button', class: 'btn primary', onclick: submit }, confirmLabel)),
    );
    setTimeout(() => { area.setSelectionRange(0, 0); area.scrollTop = 0; }, 0);
  });
}

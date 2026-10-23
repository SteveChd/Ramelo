// Keyboard shortcuts: each key combination runs the action that declares it (`app/actions.js`).

import { actionForShortcut, run } from './actions.js';

function combo(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  // With Shift, digits come as symbols on some layouts: the physical key is used instead.
  const digit = /^Digit(\d)$/.exec(event.code)?.[1];
  parts.push(digit && (event.ctrlKey || event.metaKey) ? digit : key);
  return parts.join('+');
}

export function installKeyboard() {
  window.addEventListener('keydown', (event) => {
    // Text fields keep their plain keys; Ctrl shortcuts and function keys still work there.
    const typing = event.target.closest?.('input, textarea, select');
    if (typing && !(event.ctrlKey || event.metaKey) && !/^F\d+$/.test(event.key)) return;
    const name = actionForShortcut(combo(event));
    if (!name) return;
    event.preventDefault();
    run(name);
  });
}

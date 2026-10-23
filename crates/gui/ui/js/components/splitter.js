// Splitter between two panels: dragging it resizes one of them, a double click folds it.

import { h } from '../lib/dom.js';
import { layout } from '../state/layout.js';

/**
 * `name`: the size in the layout ('left', 'right' or 'diff'). `axis`: 'x' (a vertical bar) or 'y'.
 * `sign`: 1 when moving right or down makes the panel larger, -1 otherwise.
 * `fold`: the layout key folded by a double click.
 */
export function splitter({ name, axis, sign, fold, title }) {
  const bar = h('div', { class: `splitter ${axis}`, role: 'separator', 'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal', title });
  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = axis === 'x' ? event.clientX : event.clientY;
    const initial = layout.state[name];
    let size = initial;
    bar.setPointerCapture(event.pointerId);
    bar.classList.add('active');
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    const move = (e) => {
      const delta = ((axis === 'x' ? e.clientX : e.clientY) - start) * sign;
      size = layout.clamp(name, initial + delta);
      layout.set({ [name]: size }, false);
    };
    const end = () => {
      bar.removeEventListener('pointermove', move);
      bar.classList.remove('active');
      document.body.classList.remove('resizing-x', 'resizing-y');
      layout.set({ [name]: size });
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', end, { once: true });
    bar.addEventListener('pointercancel', end, { once: true });
  });
  bar.addEventListener('dblclick', () => layout.toggle(fold));
  return bar;
}

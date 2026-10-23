// Layout of the repository view: width of the side panels, height of the diff panel, and which of
// them are folded. Remembered between sessions, for all repositories.

const KEY = 'gitcontroller.layout';

export const LIMITS = {
  left: { min: 160, max: 480, initial: 230 },
  right: { min: 280, max: 640, initial: 380 },
  diff: { min: 120, max: 2000, initial: 320 },
};

const DEFAULTS = {
  left: LIMITS.left.initial,
  right: LIMITS.right.initial,
  diff: LIMITS.diff.initial,
  leftCollapsed: false,
  rightCollapsed: false,
  diffCollapsed: false,
  diffMaximized: false,
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

const state = load();
const listeners = new Set();

export const layout = {
  state,

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Changes some values; `save` false while a splitter is being dragged (saved when released). */
  set(patch, save = true) {
    Object.assign(state, patch);
    for (const listener of listeners) listener(state);
    if (save) {
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* layout not remembered */ }
    }
  },

  toggle(key) {
    layout.set({ [key]: !state[key] });
  },

  /** Keeps a size within its limits. */
  clamp(name, value) {
    const { min, max } = LIMITS[name];
    return Math.round(Math.min(max, Math.max(min, value)));
  },
};

// Settings of the application, kept in this computer's web storage: how often the pull requests are
// read from the hosting services in the background, and how often the remotes are fetched.

const KEY = 'ramelo.settings';

/** Minutes between two readings in the background; 0: none, the lists are read when shown. */
export const PULL_REFRESH_CHOICES = [0, 5, 10, 15, 30, 60];
/** Minutes between two fetches of a repository in the background; 0: only with the Fetch button. */
export const FETCH_CHOICES = [0, 5, 10, 15, 30, 60];
const DEFAULTS = { pullRefreshMinutes: 15, fetchMinutes: 10 };

const listeners = new Set();
let state = { ...DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  if (PULL_REFRESH_CHOICES.includes(saved.pullRefreshMinutes)) state.pullRefreshMinutes = saved.pullRefreshMinutes;
  if (FETCH_CHOICES.includes(saved.fetchMinutes)) state.fetchMinutes = saved.fetchMinutes;
} catch {
  // Defaults.
}

export const settings = {
  get state() { return state; },

  set(change) {
    state = { ...state, ...change };
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* setting not remembered */ }
    for (const listener of listeners) listener(state);
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

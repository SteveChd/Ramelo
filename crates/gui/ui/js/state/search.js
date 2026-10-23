// Search through the history of the repository shown: what is typed, where it is looked for, the
// matching commits (from the whole history, not only the commits drawn) and the one shown.

import * as backend from '../api/backend.js';
import { describeError } from '../app/errors.js';
import { repoStore } from './repo-store.js';

/** At most this many matches are listed. */
const LIMIT = 5000;
/** Typing waits this long before searching. */
const DELAY = 250;

export const SCOPES = ['all', 'message', 'author', 'sha', 'file', 'code'];

const state = {
  open: false,
  text: '',
  scope: 'all',
  matchCase: false,
  regex: false,
  /** Only the matching commits are listed (the graph lines are hidden). */
  onlyMatches: false,
  /** { oids, truncated } for the current text, or null. */
  result: null,
  /** The query that gave `result`, used to highlight the matches. */
  query: null,
  /** The field should take the focus at the next draw. */
  focus: false,
  /** Position of the commit shown among the matches. */
  index: -1,
  running: false,
  error: null,
};

/** The result as a set, for the graph rows. */
let matches = new Set();
const listeners = new Set();
let timer = null;
let generation = 0;

function emit() {
  for (const listener of listeners) listener(state);
}

async function run() {
  const path = repoStore.state.path;
  const text = state.text.trim();
  const mine = ++generation;
  if (!state.open || !text || !path) {
    Object.assign(state, { result: null, query: null, index: -1, running: false, error: null });
    matches = new Set();
    emit();
    return;
  }
  state.running = true;
  emit();
  let result = null;
  let error = null;
  const query = { text, scope: state.scope, matchCase: state.matchCase, regex: state.regex };
  try {
    result = await backend.searchCommits(path, query, LIMIT);
  } catch (e) {
    error = describeError(e);
  }
  if (mine !== generation) return;
  Object.assign(state, { result, query: result ? query : null, error, running: false, index: -1 });
  matches = new Set(result?.oids ?? []);
  emit();
  if (result?.oids.length) {
    if (state.onlyMatches) await repoStore.loadUntil(result.oids);
    search.go(0);
  }
}

export const search = {
  state,

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** True when a search is shown and `oid` matches it. */
  matches(oid) {
    return matches.has(oid);
  },

  get active() {
    return state.open && Boolean(state.result);
  },

  /** Shows the bar with the cursor in its field. */
  open() {
    state.open = true;
    state.focus = true;
    emit();
  },

  close() {
    state.open = false;
    clearTimeout(timer);
    run();
  },

  /** Changes the text or an option; the search runs again shortly after. */
  set(patch) {
    Object.assign(state, patch);
    emit();
    // Listing only the matches does not change them: they only need to be read into the graph.
    if (Object.keys(patch).every((key) => key === 'onlyMatches')) {
      if (state.onlyMatches && state.result?.oids.length) {
        repoStore.loadUntil(state.result.oids).then(() => state.index >= 0 && repoStore.reveal(state.result.oids[state.index]));
      }
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(run, 'text' in patch ? DELAY : 0);
  },

  /** Shows match `index` (wrapping around). */
  async go(index) {
    const oids = state.result?.oids ?? [];
    if (!oids.length) return;
    state.index = (index + oids.length) % oids.length;
    emit();
    await repoStore.reveal(oids[state.index]);
  },

  next() { return search.go(state.index + 1); },
  prev() { return search.go(state.index - 1); },

  /** Another repository is shown: its own search starts empty. */
  reset() {
    Object.assign(state, { open: false, text: '', result: null, query: null, index: -1, error: null, running: false });
    matches = new Set();
    emit();
  },
};

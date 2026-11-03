// Open pull requests of each repository of the workspace, for the indicators of the overview and the
// list in a repository's side panel. They are read from the services in the background, a few
// repositories at a time, and again after a while; a repository whose remotes match no account is
// left out.

import * as backend from '../api/backend.js';
import { accounts } from './accounts.js';

/** A list younger than this is not read again, unless asked. */
const FRESH_MS = 5 * 60 * 1000;
/** Repositories read at the same time. */
const PARALLEL = 4;

/** path → { loading, hosting, pulls, error, at } (`hosting` null: no account for this repository). */
const entries = new Map();
const listeners = new Set();
const queue = [];
let running = 0;

function emit(path) {
  for (const listener of listeners) listener(path);
}

async function read(path) {
  const entry = entries.get(path) ?? {};
  entries.set(path, { ...entry, loading: true });
  emit(path);
  try {
    const list = await backend.pullRequests(path, true);
    entries.set(path, { loading: false, hosting: list?.hosting ?? null, pulls: list?.pulls ?? [], error: null, at: Date.now() });
  } catch (error) {
    entries.set(path, { ...entry, loading: false, error, at: Date.now() });
  }
  emit(path);
}

function pump() {
  while (running < PARALLEL && queue.length) {
    const path = queue.shift();
    running += 1;
    read(path).finally(() => {
      running -= 1;
      pump();
    });
  }
}

export const pulls = {
  /** What is known of the pull requests of `path`, or null before it was ever read. */
  of(path) {
    return entries.get(path) ?? null;
  },

  /** Reads the pull requests of these repositories again, unless read recently (`force`: anyway). */
  async refresh(paths, { force = false } = {}) {
    await accounts.load();
    if (!accounts.list.length) {
      if (entries.size) {
        entries.clear();
        emit(null);
      }
      return;
    }
    const now = Date.now();
    for (const path of paths) {
      const entry = entries.get(path);
      if (entry?.loading || queue.includes(path)) continue;
      if (!force && entry && now - entry.at < FRESH_MS) continue;
      queue.push(path);
    }
    pump();
  },

  /** The list of one repository changed (a pull request merged, closed or opened): read it now. */
  reload(path) {
    return read(path);
  },

  /** Forgets everything (accounts changed). */
  clear() {
    entries.clear();
    emit(null);
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

// A new or removed account changes which repositories have pull requests to show.
accounts.subscribe(() => pulls.clear());

// Remotes fetched in the background, at the pace of the settings: every repository of the workspace
// that has a remote, one at a time, the one shown first, even when its tab is closed (the overview
// shows what arrived). Such a fetch never asks anything and its failures are not shown: offline, a
// server not trusted yet or a password wanted, the Fetch button explains it.

import * as backend from '../api/backend.js';
import { repoStore } from './repo-store.js';
import { settings } from './settings.js';
import { store } from './store.js';

/** How often it is checked whether repositories are due again. */
const TICK_MS = 60 * 1000;
/** First round after the start, once the repositories are read. */
const FIRST_MS = 30 * 1000;
/** A fetch that has not ended by then no longer holds the next repositories back. */
const GIVE_UP_MS = 5 * 60 * 1000;
/** Commands of the user that fetch: the repository is not due again before the pace. */
const FETCHING = new Set(['fetch', 'pull']);

/** path → time of its last fetch (in the background or by the user), while the application runs. */
const last = new Map();
let round = false;

const paceMs = () => (settings.state.fetchMinutes || 0) * 60 * 1000;

function withDeadline(promise) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), GIVE_UP_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The repository is in use by a command of the user: left for the next round. */
const busy = (path) => repoStore.state.path === path && repoStore.state.running !== null;

async function fetchDue() {
  if (round || !paceMs()) return;
  round = true;
  try {
    const due = (now) => store.repositories
      .filter((r) => r.summary?.remotes?.length && now - (last.get(r.path) ?? 0) >= paceMs())
      .map((r) => r.path);
    const paths = due(Date.now());
    const order = [...paths.filter((p) => p === store.active), ...paths.filter((p) => p !== store.active)];
    for (const path of order) {
      // The pace may have been changed, or the repository closed or fetched by the user meanwhile.
      if (!paceMs() || !due(Date.now()).includes(path) || busy(path)) continue;
      last.set(path, Date.now());
      let result = null;
      try {
        result = await withDeadline(backend.backgroundFetch(path));
      } catch {
        continue;
      }
      if (!result?.moved || !result.snapshot || busy(path)) continue;
      if (!store.repositories.some((r) => r.path === path)) continue;
      await repoStore.backgroundFetched(path, result.snapshot);
    }
  } finally {
    round = false;
  }
}

// A fetch or a pull of the user counts: the repository is fetched again only after the pace.
repoStore.subscribe((topic, state) => {
  if (topic === 'running' && FETCHING.has(state.running) && state.path) last.set(state.path, Date.now());
});

// A shorter pace chosen in the settings takes effect at the next tick.
setInterval(() => { fetchDue().catch(() => {}); }, TICK_MS);
setTimeout(() => { fetchDue().catch(() => {}); }, FIRST_MS);

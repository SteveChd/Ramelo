// Pull requests already read, kept while the application runs, so that opening one again shows it at
// once. The open pull requests of the repository shown are also read in the background, one at a
// time and not often: a pull request is read again only when the list says it changed (another
// update time or another last commit), or after a long while. One that is no longer open (merged,
// closed) leaves the cache when the list is read again.

import * as backend from '../api/backend.js';
import { pulls } from './pulls.js';
import { repoStore } from './repo-store.js';
import { store } from './store.js';

/** A conversation younger than this is shown without asking the service again. */
const VIEW_FRESH_MS = 2 * 60 * 1000;
/** Changes are read again after this, even when the list shows no new commit. */
const CHANGES_FRESH_MS = 15 * 60 * 1000;
/** A pull request is read in the background at most this often, unless it changed. */
const PREFETCH_EVERY_MS = 10 * 60 * 1000;
/** The list of the repository shown is read again this often, which reads in turn what changed. */
const LIST_EVERY_MS = 5 * 60 * 1000;
/** Pull requests read in the background, the most recently updated first. */
const PREFETCH_MAX = 8;

/** `path#number` → { view, at }. */
const views = new Map();
/** `path#number` → { data, at }. */
const changes = new Map();
/** `path#number` → time of the last reading in the background. */
const prefetched = new Map();
/** Readings under way, shared by the view and the background: `view:key` or `changes:key` → promise. */
const inflight = new Map();

const keyOf = (path, number) => `${path}#${number}`;

/** The pull request as the last list of the repository shows it. */
function listed(path, number) {
  return pulls.of(path)?.pulls?.find((p) => p.number === number) ?? null;
}

/** Same commit, though one service gives a short hash. */
const sameOid = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));

function changedSince(view, path, number) {
  const pull = listed(path, number);
  const details = view.details;
  if (!pull) return false;
  return pull.updated !== details.updated || (pull.headOid && details.headOid && !sameOid(pull.headOid, details.headOid));
}

function share(name, call) {
  if (inflight.has(name)) return inflight.get(name);
  const promise = call().finally(() => inflight.delete(name));
  inflight.set(name, promise);
  return promise;
}

function forget(key) {
  views.delete(key);
  changes.delete(key);
  prefetched.delete(key);
}

export const pullCache = {
  /** { view, stale } for a pull request read before, or null. */
  view(path, number) {
    const entry = views.get(keyOf(path, number));
    if (!entry) return null;
    return { view: entry.view, stale: Date.now() - entry.at > VIEW_FRESH_MS || changedSince(entry.view, path, number) };
  },

  /** Keeps what the service answered; a pull request no longer open is not kept. */
  putView(path, number, view) {
    const key = keyOf(path, number);
    if (view?.details?.state !== 'open') forget(key);
    else views.set(key, { view, at: Date.now() });
  },

  /** Reads the conversation from the service and keeps it. */
  loadView(path, number) {
    return share(`view:${keyOf(path, number)}`, async () => {
      const view = await backend.pullRequest(path, number);
      pullCache.putView(path, number, view);
      return view;
    });
  },

  /** The changes read before, while still those of the last commit of the pull request; or null. */
  changes(path, number) {
    const entry = changes.get(keyOf(path, number));
    if (!entry || Date.now() - entry.at > CHANGES_FRESH_MS) return null;
    const head = listed(path, number)?.headOid ?? views.get(keyOf(path, number))?.view.details.headOid;
    if (head && !sameOid(head, entry.data.head)) return null;
    return entry.data;
  },

  /** Fetches the commits of the pull request and reads its changes, then keeps them. */
  loadChanges(path, number) {
    return share(`changes:${keyOf(path, number)}`, async () => {
      const data = await backend.pullRequestChanges(path, number);
      if (listed(path, number) || views.has(keyOf(path, number))) changes.set(keyOf(path, number), { data, at: Date.now() });
      return data;
    });
  },

  /** Forgets one pull request (merged or closed from here). */
  forget(path, number) {
    forget(keyOf(path, number));
  },
};

/** Drops what is kept of the pull requests of `path` that its list no longer shows open. */
function prune(path) {
  const entry = pulls.of(path);
  if (!entry || entry.loading || entry.error || !entry.pulls) return;
  const open = new Set(entry.pulls.filter((p) => p.state === 'open').map((p) => keyOf(path, p.number)));
  for (const map of [views, changes, prefetched]) {
    for (const key of [...map.keys()]) {
      if (key.startsWith(`${path}#`) && !open.has(key)) map.delete(key);
    }
  }
}

let prefetching = false;

/** Reads in the background the open pull requests of `path` that changed or were not read for long. */
async function prefetch(path) {
  if (prefetching || !path || path !== store.active) return;
  const list = pulls.of(path)?.pulls?.filter((p) => p.state === 'open') ?? [];
  const now = Date.now();
  const due = [...list]
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .slice(0, PREFETCH_MAX)
    .filter((p) => {
      const entry = views.get(keyOf(path, p.number));
      // Changed since read: read again now. Never read, or without its changes: not more often than that.
      if (entry && changedSince(entry.view, path, p.number)) return true;
      const missing = !entry || !pullCache.changes(path, p.number);
      return missing && now - (prefetched.get(keyOf(path, p.number)) ?? 0) > PREFETCH_EVERY_MS;
    });
  if (!due.length) return;
  prefetching = true;
  try {
    for (const pull of due) {
      // The repository shown changed, or a command of the user runs (a fetch, a push): stopped.
      if (store.active !== path || repoStore.state.running) break;
      prefetched.set(keyOf(path, pull.number), Date.now());
      try {
        await pullCache.loadView(path, pull.number);
        if (!pullCache.changes(path, pull.number)) await pullCache.loadChanges(path, pull.number);
      } catch {
        // Read again when opened, where an error is shown.
      }
    }
  } finally {
    prefetching = false;
  }
}

pulls.subscribe((path) => {
  if (path === null) {
    for (const map of [views, changes, prefetched]) map.clear();
    return;
  }
  prune(path);
  if (!pulls.of(path)?.loading) prefetch(path);
});

store.subscribe((topic) => {
  if (topic === 'workspace') prefetch(store.active);
});

setInterval(() => {
  if (store.active) pulls.refresh([store.active]).catch(() => {});
}, LIST_EVERY_MS);

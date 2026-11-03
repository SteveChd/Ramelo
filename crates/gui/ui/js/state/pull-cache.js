// Pull requests already read, kept on disk by the backend (in the data folder of the application),
// so that opening one again shows it at once, even after a restart, without holding them in memory:
// only a small index per repository is kept here (when each was read, its update time and last commit
// then). The open pull requests of the repository shown are also read in the background, one at a
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

/** path → Map(number → { viewAt, updated, headOid, changesAt, changesHead }), as the backend keeps them. */
const indexes = new Map();
/** `path#number` → time of the last reading in the background. */
const prefetched = new Map();
/** Readings under way, shared by the view and the background: `view:key` or `changes:key` → promise. */
const inflight = new Map();

const keyOf = (path, number) => `${path}#${number}`;

async function indexOf(path) {
  if (!indexes.has(path)) {
    const list = await backend.pullCacheIndex(path).catch(() => []);
    if (!indexes.has(path)) indexes.set(path, new Map(list.map((meta) => [meta.number, meta])));
  }
  return indexes.get(path);
}

function mark(path, number, fields) {
  const index = indexes.get(path);
  if (!index) return;
  index.set(number, { ...(index.get(number) ?? { number }), ...fields });
}

/** The pull request as the last list of the repository shows it. */
function listed(path, number) {
  return pulls.of(path)?.pulls?.find((p) => p.number === number) ?? null;
}

/** Same commit, though one service gives a short hash. */
const sameOid = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));

/** The list shows another update time or another last commit than the conversation kept. */
function changedSince(meta, path, number) {
  const pull = listed(path, number);
  if (!pull || !meta?.viewAt) return false;
  return pull.updated !== meta.updated || Boolean(pull.headOid && meta.headOid && !sameOid(pull.headOid, meta.headOid));
}

/** The changes kept are recent and those of the last commit of the pull request. */
function changesCurrent(meta, path, number) {
  if (!meta?.changesAt || Date.now() - meta.changesAt > CHANGES_FRESH_MS) return false;
  const head = listed(path, number)?.headOid ?? meta.headOid;
  return !head || sameOid(head, meta.changesHead);
}

function share(name, call) {
  if (inflight.has(name)) return inflight.get(name);
  const promise = call().finally(() => inflight.delete(name));
  inflight.set(name, promise);
  return promise;
}

export const pullCache = {
  /** { view, stale } for a pull request read before, or null. */
  async view(path, number) {
    const meta = (await indexOf(path)).get(number);
    if (!meta?.viewAt) return null;
    const kept = await backend.cachedPullRequest(path, number).catch(() => null);
    if (!kept) return null;
    return { view: kept.data, stale: Date.now() - kept.at > VIEW_FRESH_MS || changedSince(meta, path, number) };
  },

  /** Notes what the service answered (the backend kept it); a pull request no longer open is not kept. */
  putView(path, number, view) {
    const details = view?.details;
    if (details?.state !== 'open') indexes.get(path)?.delete(number);
    else mark(path, number, { viewAt: Date.now(), updated: details.updated ?? null, headOid: details.headOid ?? null });
  },

  /** Reads the conversation from the service (the backend keeps it). */
  loadView(path, number) {
    return share(`view:${keyOf(path, number)}`, async () => {
      await indexOf(path);
      const view = await backend.pullRequest(path, number);
      pullCache.putView(path, number, view);
      return view;
    });
  },

  /** The changes kept, while still those of the last commit of the pull request; or null. */
  async changes(path, number) {
    if (!changesCurrent((await indexOf(path)).get(number), path, number)) return null;
    const kept = await backend.cachedPullRequestChanges(path, number).catch(() => null);
    return kept?.data ?? null;
  },

  /** Fetches the commits of the pull request and reads its changes (the backend keeps them). */
  loadChanges(path, number) {
    return share(`changes:${keyOf(path, number)}`, async () => {
      await indexOf(path);
      const data = await backend.pullRequestChanges(path, number);
      mark(path, number, { changesAt: Date.now(), changesHead: data.head });
      return data;
    });
  },
};

/** The backend dropped the pull requests that its list no longer shows open: the index follows. */
function prune(path) {
  const entry = pulls.of(path);
  const index = indexes.get(path);
  if (!entry || entry.loading || entry.error || !entry.pulls) return;
  const open = new Set(entry.pulls.filter((p) => p.state === 'open').map((p) => p.number));
  for (const number of [...(index?.keys() ?? [])]) {
    if (!open.has(number)) index.delete(number);
  }
  for (const key of [...prefetched.keys()]) {
    if (key.startsWith(`${path}#`) && !open.has(Number(key.slice(path.length + 1)))) prefetched.delete(key);
  }
}

let prefetching = false;

/** Reads in the background the open pull requests of `path` that changed or were not read for long. */
async function prefetch(path) {
  if (prefetching || !path || path !== store.active) return;
  prefetching = true;
  try {
    const list = pulls.of(path)?.pulls?.filter((p) => p.state === 'open') ?? [];
    const index = await indexOf(path);
    const now = Date.now();
    const due = [...list]
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      .slice(0, PREFETCH_MAX)
      .filter((p) => {
        const meta = index.get(p.number);
        // Changed since read: read again now. Never read, or without its changes: not more often than that.
        if (changedSince(meta, path, p.number)) return true;
        const missing = !meta?.viewAt || !changesCurrent(meta, path, p.number);
        return missing && now - (prefetched.get(keyOf(path, p.number)) ?? 0) > PREFETCH_EVERY_MS;
      });
    if (!due.length) return;
    for (const pull of due) {
      // The repository shown changed, or a command of the user runs (a fetch, a push): stopped.
      if (store.active !== path || repoStore.state.running) break;
      prefetched.set(keyOf(path, pull.number), Date.now());
      try {
        await pullCache.loadView(path, pull.number);
        if (!changesCurrent(index.get(pull.number), path, pull.number)) await pullCache.loadChanges(path, pull.number);
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
    indexes.clear();
    prefetched.clear();
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

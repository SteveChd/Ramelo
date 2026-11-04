// Repositories watched for their pull requests: their lists are read at the pace of the settings even
// when another repository is shown or the window is behind, and what is new (a pull request opened,
// a comment of someone else) becomes a notification, kept in the list of the bell and shown by the
// system. What was seen last of each pull request (its number of comments and update time) is kept
// on this computer, so that nothing is told twice, even after a restart.

import * as backend from '../api/backend.js';
import { t } from '../i18n/i18n.js';
import { pullCache } from './pull-cache.js';
import { pulls } from './pulls.js';
import { settings } from './settings.js';
import { store } from './store.js';

const WATCHED_KEY = 'ramelo.watched';
const SEEN_KEY = 'ramelo.watchSeen';
const NOTES_KEY = 'ramelo.notifications';
/** Notifications kept, the newest first. */
const KEEP = 100;
/** How often it is checked whether the lists of the watched repositories are due again. */
const TICK_MS = 60 * 1000;
/** Comments told one by one for a pull request; beyond, one notification says how many. */
const ONE_BY_ONE = 3;

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not kept: told again after a restart at worst.
  }
}

/** Paths of the repositories watched. */
let watched = load(WATCHED_KEY, []);
/** path → { at, pulls: { number: { comments, updated } } }: what the last list read showed. */
let seen = load(SEEN_KEY, {});
/** [{ id, path, number, kind: 'pull' | 'comment', title, author, text, at, read }] */
let notes = load(NOTES_KEY, []);

const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

const nameOf = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** One's own pull requests and comments are not told. */
function mine(author, hosting) {
  return Boolean(author && hosting?.user) && author.toLowerCase() === hosting.user.toLowerCase();
}

function add(note) {
  notes = [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, read: false, at: Date.now(), ...note }, ...notes].slice(0, KEEP);
  save(NOTES_KEY, notes);
  const title = note.kind === 'pull'
    ? t('watch.newPullTitle', { repo: nameOf(note.path) })
    : t('watch.newCommentTitle', { repo: nameOf(note.path), number: note.number });
  backend.notify(title, note.text).catch(() => {});
  emit();
}

/**
 * The comments of `pull` written by others since it was last seen, read from the service (the cache
 * keeps them): those not among the comments known of it, or, before any was known, those written after
 * its last update then (the clock of the service, not of this computer).
 */
async function newComments(path, pull, was, hosting) {
  let view;
  try {
    view = await pullCache.loadView(path, pull.number);
  } catch {
    return;
  }
  const comments = view?.comments ?? [];
  const known = was.ids ? new Set(was.ids) : null;
  const entry = seen[path]?.pulls[pull.number];
  if (entry) {
    entry.ids = comments.map((c) => c.id);
    save(SEEN_KEY, seen);
  }
  const isNew = (c) => (known ? !known.has(c.id) : (c.created ?? 0) > (was.updated ?? Infinity));
  const fresh = comments.filter((c) => isNew(c) && !mine(c.author, hosting));
  if (fresh.length > ONE_BY_ONE) {
    add({ path, number: pull.number, kind: 'comment', title: pull.title, author: null, text: t('watch.manyComments', { n: fresh.length, number: pull.number, title: pull.title }) });
    return;
  }
  for (const c of fresh) {
    // Plain text: the marks of Markdown would show as they are.
    const text = c.body.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
    add({
      path,
      number: pull.number,
      kind: 'comment',
      title: pull.title,
      author: c.author,
      text: t('watch.commentText', { author: c.author, number: pull.number, text: text.length > 140 ? `${text.slice(0, 139)}…` : text }),
    });
  }
}

/** Compares the list just read of a watched repository with what was seen of it. */
async function compare(path) {
  const entry = pulls.of(path);
  if (!watched.includes(path) || !entry || entry.loading || entry.error || !entry.pulls || !entry.hosting) return;
  const before = seen[path];
  const now = Date.now();
  const open = entry.pulls.filter((p) => p.state === 'open');
  // The comments known of each pull request stay known until it is read again.
  seen = { ...seen, [path]: { at: now, pulls: Object.fromEntries(open.map((p) => [p.number, { comments: p.comments ?? null, updated: p.updated ?? null, ids: before?.pulls[p.number]?.ids }])) } };
  save(SEEN_KEY, seen);
  // First reading since watched: what is there is the starting point, nothing is new.
  if (!before) return;
  for (const pull of open) {
    const was = before.pulls[pull.number];
    if (!was) {
      if (!mine(pull.author, entry.hosting)) {
        add({ path, number: pull.number, kind: 'pull', title: pull.title, author: pull.author, text: t('watch.pullText', { author: pull.author, number: pull.number, title: pull.title }) });
      }
      continue;
    }
    // More comments, or (a service that does not count them) another update: the conversation is read.
    const more = pull.comments !== null && pull.comments !== undefined && was.comments !== null ? pull.comments > was.comments : pull.updated !== was.updated;
    if (more) await newComments(path, pull, was, entry.hosting);
  }
}

export const watch = {
  isWatched(path) {
    return watched.includes(path);
  },

  /** Watches a repository, or stops watching it. */
  toggle(path) {
    if (watched.includes(path)) {
      watched = watched.filter((p) => p !== path);
      const { [path]: _, ...rest } = seen;
      seen = rest;
      save(SEEN_KEY, seen);
    } else {
      watched = [...watched, path];
      pulls.refresh([path], { force: true });
    }
    save(WATCHED_KEY, watched);
    emit();
  },

  /** The notifications, the newest first. */
  get notes() {
    return notes;
  },

  get unread() {
    return notes.filter((n) => !n.read).length;
  },

  markAllRead() {
    if (!notes.some((n) => !n.read)) return;
    notes = notes.map((n) => ({ ...n, read: true }));
    save(NOTES_KEY, notes);
    emit();
  },

  markRead(id) {
    notes = notes.map((n) => (n.id === id ? { ...n, read: true } : n));
    save(NOTES_KEY, notes);
    emit();
  },

  clear() {
    notes = [];
    save(NOTES_KEY, notes);
    emit();
  },

  /** A repository left the workspace: no longer watched. */
  forget(path) {
    if (watched.includes(path)) watch.toggle(path);
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

pulls.subscribe((path) => {
  if (path !== null) compare(path);
});

// The lists of the watched repositories are read at the pace of the settings, whatever is shown.
/** The watched repositories still in the workspace. */
const present = () => watched.filter((path) => store.repositories.some((r) => r.path === path));

setInterval(() => {
  if (present().length && settings.state.pullRefreshMinutes) pulls.refresh(present()).catch(() => {});
}, TICK_MS);
setTimeout(() => {
  if (present().length) pulls.refresh(present()).catch(() => {});
}, 5000);

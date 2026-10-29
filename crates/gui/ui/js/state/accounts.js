// Accounts on hosting services (GitHub, GitLab, Bitbucket): the list, kept by the backend with their
// tokens in the system's credential store.

import * as backend from '../api/backend.js';

const listeners = new Set();
let list = [];
let loaded = null;

function set(next) {
  list = next;
  for (const listener of listeners) listener(list);
}

/** Services Ramelo works with, in the order they are offered. `fixed`: one address only. */
export const PROVIDERS = [
  { id: 'github', defaultUrl: 'https://github.com' },
  { id: 'gitlab', defaultUrl: 'https://gitlab.com' },
  { id: 'bitbucket', defaultUrl: 'https://bitbucket.org', fixed: true, login: true },
  { id: 'bitbucketServer', defaultUrl: null },
];

export const accounts = {
  get list() { return list; },

  /** Reads the accounts once; later calls wait for the same reading. */
  load() {
    loaded ??= backend.listAccounts().then(set, () => set([]));
    return loaded;
  },

  /** Checks the token with the service and keeps the account; rejects with the reason it failed. */
  async add({ provider, url, login, token }) {
    set(await backend.addAccount(provider, url, login || null, token));
  },

  async remove(id) {
    set(await backend.removeAccount(id));
  },

  /** Rejects when the service no longer accepts the token. */
  check(id) {
    return backend.checkAccount(id);
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

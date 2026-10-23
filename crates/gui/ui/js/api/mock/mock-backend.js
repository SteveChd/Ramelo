// Fake backend for the design preview in a browser: same functions and same snapshots as the Tauri
// commands, on sample repositories kept in memory.

import { sampleWorkspace } from './sample-workspace.js';

const delay = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const nameOf = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

let repositories = [];
let active = null;
let added = 0;

function snapshot() {
  return structuredClone({
    repositories: repositories.map((r) => ({ path: r.path, name: nameOf(r.path), summary: r.summary ?? null, error: r.error ?? null })),
    active,
  });
}

export async function startup() {
  await delay(300);
  repositories = sampleWorkspace();
  active = null;
  return snapshot();
}

export async function refresh() {
  await delay(250);
  return snapshot();
}

/** The preview has no folder chooser: each call « finds » a new sample repository. */
export async function pickFolder() {
  added += 1;
  return [`C:\\Users\\steve\\dev\\new-repo-${added}`];
}

export async function addRepositories(paths) {
  await delay();
  const fresh = paths.filter((p) => !repositories.some((r) => r.path === p));
  for (const path of fresh) {
    repositories.push({
      path,
      summary: {
        head: { branch: 'main', oid: null }, upstream: null, ahead: 0, behind: 0, stashes: 0, operation: null,
        remotes: [], lastCommit: null, files: [], fileCount: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0,
      },
    });
  }
  active = paths[0];
  return { snapshot: snapshot(), added: fresh, existing: paths.length - fresh.length };
}

export async function removeRepository(path) {
  const index = repositories.findIndex((r) => r.path === path);
  if (index >= 0) repositories.splice(index, 1);
  if (active === path) active = (repositories[index] ?? repositories[index - 1])?.path ?? null;
  return snapshot();
}

export async function selectRepository(path) {
  active = repositories.some((r) => r.path === path) ? path : null;
  return snapshot();
}

export async function reorderRepository(path, index) {
  const from = repositories.findIndex((r) => r.path === path);
  if (from < 0) return snapshot();
  const [entry] = repositories.splice(from, 1);
  repositories.splice(Math.min(index, repositories.length), 0, entry);
  return snapshot();
}

export async function openFolder() {}
export async function setLanguage() {}
export async function showWindow() {}
export function onFoldersDropped() {}

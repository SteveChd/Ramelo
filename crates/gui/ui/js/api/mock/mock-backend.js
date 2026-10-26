// Fake backend for the design preview in a browser: same functions and same snapshots as the Tauri
// commands, on sample repositories kept in memory.

import * as repo from './mock-repo.js';
import { sampleWorkspace } from './sample-workspace.js';

const delay = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const nameOf = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

let repositories = [];
let active = null;
let added = 0;

function snapshot() {
  return structuredClone({
    repositories: repositories.map((r) => ({ path: r.path, name: nameOf(r.path), color: r.color ?? null, closed: Boolean(r.closed), summary: r.summary ?? null, error: r.error ?? null })),
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
  for (const repo of repositories) if (paths.includes(repo.path)) repo.closed = false;
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

export async function closeRepository(path) {
  const index = repositories.findIndex((r) => r.path === path);
  if (index < 0) return snapshot();
  repositories[index].closed = true;
  if (active === path) {
    const open = (r) => !r.closed;
    active = (repositories.slice(index + 1).find(open) ?? repositories.slice(0, index).reverse().find(open))?.path ?? null;
  }
  return snapshot();
}

export async function selectRepository(path) {
  const repo = repositories.find((r) => r.path === path);
  if (repo) repo.closed = false;
  active = repo ? path : null;
  return snapshot();
}

export async function reorderRepository(path, index) {
  const from = repositories.findIndex((r) => r.path === path);
  if (from < 0) return snapshot();
  const [entry] = repositories.splice(from, 1);
  repositories.splice(Math.min(index, repositories.length), 0, entry);
  return snapshot();
}

export async function setRepositoryColor(path, color) {
  const repo = repositories.find((r) => r.path === path);
  if (repo) repo.color = color;
  return snapshot();
}

export async function openFolder() {}

// ---------- One repository ----------

const find = (path) => repositories.find((r) => r.path === path);

/** Counts of a summary after its files changed. */
function recount(summary) {
  const files = summary.files;
  const count = (test) => files.filter(test).length;
  Object.assign(summary, {
    fileCount: files.length,
    staged: count((f) => !['unmodified', 'untracked', 'ignored', 'conflicted'].includes(f.index)),
    unstaged: count((f) => ['modified', 'typeChanged', 'deleted'].includes(f.worktree)),
    untracked: count((f) => f.worktree === 'untracked'),
    conflicted: count((f) => f.index === 'conflicted'),
  });
}

function change(path, update) {
  const summary = find(path)?.summary;
  if (summary) {
    update(summary);
    recount(summary);
  }
  return snapshot();
}

export async function history(path, limit) {
  await delay(80);
  return repo.history(path, limit);
}

export async function searchCommits(path, query, limit) {
  await delay(120);
  return repo.searchCommits(path, query, limit);
}

export async function commitDetails(path, oid) {
  await delay(60);
  return repo.commitDetails(path, oid);
}

export async function rewriteInfo(path, oid) {
  await delay();
  const rows = repo.history(path, 400).rows;
  const index = rows.findIndex((r) => r.oid === oid);
  return { editable: index >= 0, descendants: Math.max(index, 0), pushedTo: index > 2 ? ['origin/main'] : [] };
}

export async function rewordCommit(path, oid) {
  await delay(300);
  return { head: oid, commit: oid, snapshot: snapshot() };
}

export async function editCommitFile(path, oid) {
  await delay(300);
  return { head: oid, commit: oid, snapshot: snapshot() };
}

export async function fileVersions(path, file) {
  await delay(60);
  return repo.fileVersions(file);
}

export async function commitFileDiff(path, oid, file) {
  return repo.diffFor(file);
}

export async function fileDiff(path, file, staged) {
  await delay(40);
  const entry = find(path)?.summary?.files.find((f) => f.path === file);
  if (!entry) return null;
  const kind = staged ? entry.index : entry.worktree;
  if (['unmodified', 'ignored'].includes(kind)) return null;
  return repo.diffFor(file, kind === 'untracked' ? 'added' : kind);
}

const stagedKind = (f) => (f.worktree === 'untracked' ? 'added' : f.worktree === 'unmodified' ? f.index : f.worktree);

export async function stage(path, files) {
  return change(path, (s) => s.files.forEach((f) => {
    if (files.includes(f.path)) Object.assign(f, { index: stagedKind(f), worktree: 'unmodified' });
  }));
}

export async function stageAll(path) {
  return change(path, (s) => s.files.forEach((f) => Object.assign(f, { index: stagedKind(f), worktree: 'unmodified' })));
}

export async function unstage(path, files) {
  return change(path, (s) => s.files.forEach((f) => {
    if (files.includes(f.path)) Object.assign(f, { worktree: f.index === 'added' ? 'untracked' : f.index, index: f.index === 'added' ? 'untracked' : 'unmodified' });
  }));
}

export async function unstageAll(path) {
  const files = find(path)?.summary?.files.map((f) => f.path) ?? [];
  return unstage(path, files);
}

export async function discard(path, tracked, untracked) {
  return change(path, (s) => {
    s.files = s.files
      .filter((f) => !untracked.includes(f.path))
      .map((f) => (tracked.includes(f.path) ? { ...f, worktree: 'unmodified' } : f))
      .filter((f) => f.index !== 'unmodified' || f.worktree !== 'unmodified');
  });
}

export async function applyHunk(path, file, untracked, index, header, action) {
  if (action === 'stage') return stage(path, [file]);
  if (action === 'unstage') return unstage(path, [file]);
  return discard(path, [file], []);
}

export async function commit(path, message, amend, all) {
  await delay(200);
  const r = find(path);
  const commitOid = Math.random().toString(16).slice(2).padEnd(40, '0');
  change(path, (s) => {
    if (all) s.files.forEach((f) => Object.assign(f, { index: stagedKind(f), worktree: 'unmodified' }));
    s.files = s.files.filter((f) => f.worktree !== 'unmodified');
    s.ahead += amend ? 0 : 1;
    s.lastCommit = { oid: commitOid, summary: message.split('\n')[0], author: 'Steve Chadaud', time: Math.floor(Date.now() / 1000) };
    s.head.oid = commitOid;
  });
  return { snapshot: snapshot(), oid: r ? commitOid : '' };
}

export async function lastMessage(path) {
  return find(path)?.summary?.lastCommit?.summary ?? null;
}

export async function branches(path) {
  await delay(50);
  return repo.branches(path);
}

export async function switchBranch(path, target) {
  await delay(150);
  const r = find(path);
  if (r?.summary?.unstaged) throw { code: 'local_changes', subject: target, message: 'local changes would be overwritten' };
  if (r?.summary) {
    const refs = repo.branches(path);
    const tip = [...refs.local, ...refs.remote].find((b) => b.name === target)?.oid;
    r.summary.head.branch = tip ? target.replace(/^origin\//, '') : null;
    r.summary.head.oid = tip ?? target;
  }
  return { snapshot: snapshot(), carried: 'nothing' };
}

export async function createBranch(path, name, start, checkout) {
  if (/\s|\.\./.test(name)) throw { code: 'invalid_branch_name', subject: name, message: 'invalid' };
  const dirty = repositories.find((r) => r.path === path)?.summary?.fileCount > 0;
  if (!checkout) return { snapshot: snapshot(), carried: 'nothing' };
  const result = await change(path, (s) => { s.head.branch = name; s.upstream = null; s.ahead = 0; s.behind = 0; });
  return { snapshot: result, carried: dirty ? 'reapplied' : 'nothing' };
}

export async function deleteBranch(path, name, force) {
  if (!force && name !== 'old-experiment') throw { code: 'branch_not_merged', subject: name, message: 'not merged' };
  return snapshot();
}

export async function fetch(path) {
  await delay(600);
  return snapshot();
}

export async function pull(path, mode) {
  await delay(600);
  const s = find(path)?.summary;
  if (s?.ahead && s.behind && mode === 'auto') throw { code: 'diverged', subject: null, message: 'diverged' };
  const commits = s?.behind ?? 0;
  change(path, (summary) => { summary.behind = 0; });
  const kind = commits === 0 ? 'upToDate' : mode === 'auto' ? 'fastForwarded' : mode === 'rebase' ? 'rebased' : 'merged';
  return { snapshot: snapshot(), outcome: { kind, commits } };
}

export async function push(path) {
  await delay(600);
  const s = find(path)?.summary;
  if (s?.behind) throw { code: 'push_rejected', subject: 'non-fast-forward', message: 'rejected' };
  const upstreamSet = !s?.upstream;
  change(path, (summary) => { summary.ahead = 0; summary.upstream ??= `origin/${summary.head.branch}`; });
  return { snapshot: snapshot(), outcome: { remote: 'origin', branch: s?.head.branch ?? 'main', upstreamSet } };
}
export async function setLanguage() {}
export async function showWindow() {}
export function onFoldersDropped() {}

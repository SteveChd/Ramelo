// Fake backend for the design preview in a browser: same functions and same snapshots as the Tauri
// commands, on sample repositories kept in memory.

import * as repo from './mock-repo.js';
import { sampleWorkspace } from './sample-workspace.js';

const delay = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const nameOf = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

let repositories = [];
let sections = [];
let othersCollapsed = false;
let active = null;
let added = 0;

function snapshot() {
  return structuredClone({
    repositories: repositories.map((r) => ({ path: r.path, name: nameOf(r.path), color: r.color ?? null, closed: Boolean(r.closed), pinned: Boolean(r.pinned), section: r.section ?? null, summary: r.summary ?? null, error: r.error ?? null })),
    active,
    sections,
    othersCollapsed,
  });
}

// ---------- Accounts on hosting services ----------

const DEFAULT_URLS = { github: 'https://github.com', gitlab: 'https://gitlab.com', bitbucket: 'https://bitbucket.org' };
let accounts = [
  { id: 'steve@https://github.com', provider: 'github', url: 'https://github.com', username: 'steve-c', name: 'Steve Chadaud' },
];

/** A token containing « bad » is refused, as a service would. */
export async function addAccount(provider, url, login, token) {
  await delay(500);
  const address = (url.trim() || DEFAULT_URLS[provider] || '').replace(/\/+$/, '');
  if (!/^https?:\/\/./.test(address)) throw { code: 'invalid_url', subject: address, message: 'not a web address' };
  if (!token.trim()) throw { code: 'token_missing', subject: null, message: 'the token is empty' };
  if (provider === 'bitbucket' && !login?.trim()) throw { code: 'login_missing', subject: null, message: 'e-mail missing' };
  if (token.includes('bad')) throw { code: 'hosting_unauthorized', subject: null, message: 'the service refused the token' };
  const username = provider === 'bitbucket' ? login.split('@')[0] : 'steve';
  const id = `${username}@${address}`;
  accounts = accounts.filter((a) => a.id !== id).concat({ id, provider, url: provider === 'bitbucket' ? DEFAULT_URLS.bitbucket : address, username, name: 'Steve Chadaud', login: login?.trim() || null });
  return structuredClone(accounts);
}

export async function listAccounts() {
  return structuredClone(accounts);
}

export async function checkAccount(id) {
  await delay(400);
  if (!accounts.some((a) => a.id === id)) throw { code: 'hosting_no_account', subject: id, message: 'no account' };
}

export async function removeAccount(id) {
  accounts = accounts.filter((a) => a.id !== id);
  return structuredClone(accounts);
}

export async function tokenPage(provider, url) {
  return `${url || DEFAULT_URLS[provider] || ''}/settings/tokens`;
}

export async function openUrl(url) {
  window.open(url, '_blank', 'noopener');
}

export async function startup() {
  await delay(300);
  repositories = sampleWorkspace();
  // « ?many=200 » adds as many sample repositories, to see a crowded tab bar.
  const many = Number(new URLSearchParams(location.search).get('many')) || 0;
  const words = ['core', 'utils', 'pipeline', 'exporter', 'gateway', 'firmware', 'shared', 'lib', 'tools', 'service'];
  for (let i = 0; i < many; i += 1) {
    const name = `${words[i % words.length]}-${String.fromCharCode(97 + (i * 7) % 26)}${i}`;
    repositories.push({ path: `C:\\codes\\many\\${name}`, summary: structuredClone(repositories[1].summary) });
  }
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

export async function removeRepositories(paths) {
  for (const path of paths) await removeRepository(path);
  return snapshot();
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

export async function pickCloneFolder(start) {
  return start || 'C:\\Users\\steve\\dev';
}

let cloneStopped = false;

/** A pretend clone: a few seconds of progress; « fail » in the address makes it fail. */
export async function cloneRepository(url, folder, options, onProgress) {
  cloneStopped = false;
  for (const phase of ['Counting objects', 'Receiving objects', 'Resolving deltas']) {
    for (let percent = 0; percent <= 100; percent += 20) {
      await delay(90);
      if (cloneStopped) throw { code: 'cancelled', subject: null, message: 'stopped' };
      onProgress({ phase, percent, detail: '' });
    }
  }
  if (url.includes('fail')) throw { code: 'git_failed', subject: 'clone', message: `repository '${url}' not found` };
  return folder;
}

export async function cancelClone() {
  cloneStopped = true;
}

export async function closeRepositories(paths) {
  for (const path of paths) {
    const repo = repositories.find((r) => r.path === path);
    if (repo) repo.pinned = false;
    await closeRepository(path);
  }
  return snapshot();
}

export async function setRepositoryPinned(path, pinned) {
  const from = repositories.findIndex((r) => r.path === path);
  if (from < 0) return snapshot();
  const [entry] = repositories.splice(from, 1);
  entry.pinned = pinned;
  if (pinned) entry.closed = false;
  const at = repositories.findIndex((r) => !r.pinned);
  repositories.splice(at < 0 ? repositories.length : at, 0, entry);
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
  const pinned = repositories.filter((r) => r.pinned).length;
  const at = entry.pinned ? Math.min(index, pinned) : Math.max(pinned, Math.min(index, repositories.length));
  repositories.splice(at, 0, entry);
  return snapshot();
}

export async function setRepositoryColor(path, color) {
  const repo = repositories.find((r) => r.path === path);
  if (repo) repo.color = color;
  return snapshot();
}

const sectionTaken = (name) => ({ code: 'section_exists', subject: name.trim(), message: 'a section already has this name' });
const hasSection = (name) => sections.some((s) => s.name === name);

export async function addSection(name) {
  const clean = name.trim();
  if (!clean || hasSection(clean)) throw sectionTaken(name);
  sections.push({ name: clean });
  return snapshot();
}

export async function renameSection(name, newName) {
  const clean = newName.trim();
  if (!clean || (clean !== name && hasSection(clean))) throw sectionTaken(newName);
  const section = sections.find((s) => s.name === name);
  if (section) section.name = clean;
  for (const r of repositories) if (r.section === name) r.section = clean;
  return snapshot();
}

export async function removeSection(name) {
  sections = sections.filter((s) => s.name !== name);
  for (const r of repositories) if (r.section === name) r.section = null;
  return snapshot();
}

export async function moveSection(name, index) {
  const from = sections.findIndex((s) => s.name === name);
  if (from < 0) return snapshot();
  const [section] = sections.splice(from, 1);
  sections.splice(Math.min(index, sections.length), 0, section);
  return snapshot();
}

export async function setSectionCollapsed(name, collapsed) {
  if (name === null) othersCollapsed = collapsed;
  else {
    const section = sections.find((s) => s.name === name);
    if (section) section.collapsed = collapsed;
  }
  return snapshot();
}

export async function setRepositoriesSection(paths, section) {
  const clean = section?.trim() || null;
  if (clean && !hasSection(clean)) sections.push({ name: clean });
  for (const r of repositories) if (paths.includes(r.path)) r.section = clean;
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
  const row = rows[index];
  const parent = row?.parents.length === 1 ? row.parents[0] : null;
  const squash = parent ? { parent, pushedTo: index + 1 > 2 ? ['origin/main'] : [] } : null;
  return { editable: index >= 0, descendants: Math.max(index, 0), pushedTo: index > 2 ? ['origin/main'] : [], squash };
}

export async function squashCommit(path, oid) {
  await delay(300);
  return { head: oid, commit: oid, snapshot: snapshot() };
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

// ---------- Conflicts ----------

const resolved = (path, file) => change(path, (s) => s.files.forEach((f) => {
  if (f.path === file) Object.assign(f, { index: 'modified', worktree: 'unmodified' });
}));

export async function continueOperation(path) {
  await delay(300);
  return { progress: 'done', snapshot: change(path, (s) => { s.operation = null; }) };
}

export async function skipCommit(path) {
  return continueOperation(path);
}

export async function abortOperation(path) {
  await delay(300);
  return change(path, (s) => {
    s.operation = null;
    s.files = s.files.filter((f) => f.index !== 'conflicted');
  });
}

export async function conflictFile(path, file) {
  await delay(80);
  const common = (lines) => ({ kind: 'common', text: lines.join('\n') + '\n' });
  return {
    path: file,
    binary: false,
    ours: '',
    theirs: '',
    base: '',
    working: '',
    segments: [
      common(['use std::time::Duration;', '', 'pub struct Watch {', '    counters: Vec<Counter>,', '}', '', 'impl Watch {']),
      {
        kind: 'conflict',
        ours: '    pub fn poll(&mut self) -> Result<(), Error> {\n        let interval = Duration::from_millis(500);\n',
        base: '    pub fn poll(&mut self) {\n        let interval = Duration::from_secs(1);\n',
        theirs: '    pub fn poll(&mut self) {\n        let interval = self.interval;\n',
      },
      common(['        for counter in &mut self.counters {', '            counter.read();', '        }']),
      {
        kind: 'conflict',
        ours: '        Ok(())\n',
        base: '',
        theirs: '        self.last = Instant::now();\n',
      },
      common(['    }', '}']),
    ],
    sides: {
      operation: 'rebase',
      ours: { name: 'origin/main', oid: '55aa66bb', summary: 'Report polling errors' },
      theirs: { name: 'main', oid: '77bb88cc', summary: 'Poll the network counters every second' },
    },
  };
}

export async function resolveConflict(path, file) {
  await delay(150);
  return resolved(path, file);
}

export async function takeConflictSide(path, file) {
  await delay(150);
  return resolved(path, file);
}

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

/** Repositories read since the start, as the backend reads them one by one after `startup`. */
const read = new Set();

function snapshot() {
  return structuredClone({
    repositories: repositories.map((r) => {
      const seen = read.has(r.path) || everyRead;
      return { path: r.path, name: nameOf(r.path), color: r.color ?? null, closed: Boolean(r.closed), pinned: Boolean(r.pinned), section: r.section ?? null, summary: seen ? r.summary ?? null : null, error: seen ? r.error ?? null : null };
    }),
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
  if (!/^https?:\/\/[^@\s]+$/.test(address) && provider !== 'bitbucket') throw { code: 'server_url_invalid', subject: url.trim(), message: 'not a web address' };
  if (!token.trim()) throw { code: 'token_missing', subject: null, message: 'the token is empty' };
  if (provider === 'bitbucket' && !login?.trim()) throw { code: 'login_missing', subject: null, message: 'e-mail missing' };
  if (provider === 'bitbucket' && (!login.includes('@') || login.includes('/'))) throw { code: 'login_not_email', subject: login.trim(), message: 'not an e-mail' };
  if (token.includes('bad')) throw { code: provider === 'bitbucket' ? 'bitbucket_unauthorized' : 'hosting_unauthorized', subject: null, message: 'the service refused the token' };
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

const REMOTE_REPOS = [
  ['steve-c/ramelo', 'Desktop git client for people who juggle many repositories', 'Rust', 12, false],
  ['steve-c/dotfiles', 'Shell, editor and terminal settings', 'Shell', 0, false],
  ['acme/device-ui', 'User interface of the device', 'TypeScript', 0, true],
  ['acme/firmware-tools', 'Tools to flash and inspect the firmware', 'Python', 2, true],
  ['acme/pipeline', null, 'Kotlin', 0, true],
  ['rust-lang/rust', 'Empowering everyone to build reliable and efficient software.', 'Rust', 99000, false],
];

/** « fail » in the search fails, as a service out of reach would. */
export async function searchRepositories(accountId, query, scope) {
  await delay(450);
  if (query.includes('fail')) throw { code: 'hosting_network', subject: 'connection refused', message: 'cannot reach' };
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const now = Math.floor(Date.now() / 1000);
  return REMOTE_REPOS
    .filter(([name]) => scope === 'all' || !name.startsWith('rust-lang/'))
    .filter(([name, description]) => words.every((w) => `${name} ${description ?? ''}`.toLowerCase().includes(w)))
    .map(([name, description, language, stars, priv], i) => ({
      key: name, fullName: name, description, private: priv, fork: name.endsWith('dotfiles'),
      webUrl: `https://github.com/${name}`, cloneHttps: `https://github.com/${name}.git`, cloneSsh: `git@github.com:${name}.git`,
      defaultBranch: 'main', updated: now - i * 86400 * 3, stars, language, readmePath: null,
    }));
}

export async function repositoryReadme(accountId, repo) {
  await delay(300);
  if (repo.fullName.endsWith('pipeline')) return null;
  return {
    name: 'README.md',
    text: `# ${repo.fullName.split('/').pop()}\n\n${repo.description ?? ''}\n\n## Build\n\n\`\`\`sh\ncargo build --release\n\`\`\`\n\n- Fast\n- Friendly\n\n> Note: this README is a sample of the design preview.\n`,
  };
}

// ---------- Pull requests (on the sample account) ----------

const hoursAgo = (n) => Math.floor(Date.now() / 1000) - n * 3600;
const PULLS = new Map();

/** The sample pull requests of a repository, made once; « waypoint » and « spektra » have some. */
function pullsOf(path) {
  if (!PULLS.has(path)) {
    const name = nameOf(path);
    const make = (number, title, author, source, extra = {}) => ({
      number, title, author, state: 'open', draft: false, sourceBranch: source, targetBranch: 'main', sourceRepo: null, sourceCloneUrl: null,
      headOid: null, created: hoursAgo(number * 7), updated: hoursAgo(number), webUrl: `https://github.com/steve-c/${name}/pull/${number}`,
      comments: 5, reviewers: [], reviewRequested: false, ...extra,
      body: `## What\n\n${title}.\n\n## Why\n\nThe old way was slow on large projects.\n\n- [x] Tests\n- [ ] Documentation`,
      thread: [
        { id: `${number}-1`, author: 'anna', body: 'Nice! Could you add a test for the **empty** case?', created: hoursAgo(number * 5), path: null, line: null },
        { id: `${number}-2`, author: 'steve-c', body: 'Done in the last commit.', created: hoursAgo(number * 3), path: 'crates/export/src/gantt.rs', line: 14, oldSide: false, outdated: false },
        { id: `${number}-3`, author: 'anna', body: 'How about here? No need for a lock?', created: hoursAgo(number * 2.5), path: 'crates/export/src/gantt.rs', line: 40, oldSide: false, outdated: false },
        { id: `${number}-4`, author: 'steve-c', body: 'Good catch, I will add one.', created: hoursAgo(number * 2), path: null, line: null, parent: `${number}-3` },
        { id: `${number}-5`, author: 'marc', body: 'This name is misleading.', created: hoursAgo(number * 4), path: 'crates/export/src/gantt.rs', line: 9, oldSide: false, outdated: true },
      ],
    });
    const list = name === 'waypoint'
      ? [
        make(42, 'Export the Gantt chart with one column per day', 'steve-c', 'feature/gantt-export'),
        make(41, 'Shade the weekends in the calendar', 'anna', 'calendar-weekends', { reviewers: ['steve-c'], reviewRequested: true }),
        make(38, 'Draft: try a new layout engine', 'marc', 'layout-engine', { draft: true, sourceRepo: 'marc/waypoint' }),
      ]
      : name === 'spektra' ? [make(7, 'Faster spectrum smoothing', 'anna', 'smoothing', { reviewers: ['steve-c'], reviewRequested: true })] : [];
    PULLS.set(path, list);
  }
  return PULLS.get(path);
}

// For the tests of the design preview: someone else opens a pull request, or comments one.
globalThis.mockOthers = {
  open(path, title) {
    const list = pullsOf(path);
    const number = Math.max(...list.map((p) => p.number)) + 1;
    list.unshift({ ...structuredClone(list[0]), number, title, author: 'marc', comments: 0, thread: [], created: hoursAgo(0), updated: hoursAgo(0) });
    return number;
  },
  comment(path, number, body) {
    const pull = pullsOf(path).find((p) => p.number === number);
    pull.thread.push({ id: String(Date.now()), author: 'anna', body, created: Math.floor(Date.now() / 1000), path: null, line: null });
    pull.comments = (pull.comments ?? 0) + 1;
    pull.updated = Math.floor(Date.now() / 1000);
  },
};

/** The cache on disk of the application, here in memory: `path#number` → { index entry, view, changes }. */
const PULL_CACHE = new Map();

function pullView(pull, path) {
  const view = {
    details: { ...pull, thread: undefined, mergeable: pull.state === 'open' && !pull.draft, conflicts: false, mergeMethods: ['merge', 'squash', 'rebase'] },
    comments: structuredClone(pull.thread),
  };
  const key = `${path}#${pull.number}`;
  if (pull.state !== 'open') PULL_CACHE.delete(key);
  else {
    const entry = PULL_CACHE.get(key) ?? { meta: { number: pull.number } };
    Object.assign(entry.meta, { viewAt: Date.now(), updated: pull.updated, headOid: pull.headOid });
    entry.view = structuredClone(view);
    PULL_CACHE.set(key, entry);
  }
  return view;
}

export async function pullCacheIndex(path) {
  return [...PULL_CACHE.entries()].filter(([key]) => key.startsWith(`${path}#`)).map(([, e]) => ({ ...e.meta }));
}

export async function cachedPullRequest(path, number) {
  const entry = PULL_CACHE.get(`${path}#${number}`);
  return entry?.view ? { at: entry.meta.viewAt, data: structuredClone(entry.view) } : null;
}

export async function cachedPullRequestChanges(path, number) {
  const entry = PULL_CACHE.get(`${path}#${number}`);
  return entry?.changes ? { at: entry.meta.changesAt, data: structuredClone(entry.changes) } : null;
}

function findPull(path, number) {
  const pull = pullsOf(path).find((p) => p.number === number);
  if (!pull) throw { code: 'hosting_not_found', subject: `#${number}`, message: 'not found' };
  return pull;
}

export async function repositoryHosting(path) {
  const repo = repositories.find((r) => r.path === path);
  if (!repo?.summary?.remotes.length) return null;
  const name = nameOf(path);
  return { accountId: accounts[0]?.id, provider: 'github', key: `steve-c/${name}`, webUrl: `https://github.com/steve-c/${name}`, remote: 'origin', user: accounts[0]?.username ?? 'steve-c' };
}

export async function pullRequests(path, openOnly = true) {
  await delay(500);
  const hosting = await repositoryHosting(path);
  if (!hosting || !accounts.length) return null;
  const pulls = pullsOf(path).filter((p) => !openOnly || p.state === 'open').map((p) => { const { body, thread, ...rest } = p; return structuredClone(rest); });
  for (const key of [...PULL_CACHE.keys()]) {
    if (key.startsWith(`${path}#`) && !pulls.some((p) => p.state === 'open' && key === `${path}#${p.number}`)) PULL_CACHE.delete(key);
  }
  return { hosting, pulls };
}

/** Readings of pull requests, counted for the tests of the cache. */
globalThis.mockPullReads = { view: 0, changes: 0 };

export async function pullRequest(path, number) {
  globalThis.mockPullReads.view += 1;
  await delay(350);
  return pullView(findPull(path, number), path);
}

export async function pullRequestChanges(path, number) {
  globalThis.mockPullReads.changes += 1;
  await delay(700);
  findPull(path, number);
  const commits = repo.history(path, 4).rows.slice(0, 3).map((c) => ({ oid: c.oid, summary: c.summary, author: c.author, time: c.time }));
  const files = ['crates/export/src/gantt.rs', 'crates/export/src/calendar.rs', 'README.md'].map((p, i) => repo.diffFor(p, i === 1 ? 'added' : 'modified'));
  const changes = { base: 'b0b0b0b0', head: commits[0].oid, commits, files };
  const entry = PULL_CACHE.get(`${path}#${number}`) ?? { meta: { number } };
  Object.assign(entry.meta, { changesAt: Date.now(), changesHead: changes.head });
  entry.changes = structuredClone(changes);
  PULL_CACHE.set(`${path}#${number}`, entry);
  return changes;
}

export async function rangeFileDiff(path, from, to, file) {
  return repo.diffFor(file);
}

export async function commentPullRequest(path, number, body) {
  await delay(300);
  if (!body.trim()) throw { code: 'comment_empty', subject: null, message: 'empty' };
  findPull(path, number).thread.push({ id: String(Date.now()), author: accounts[0]?.username ?? 'me', body, created: Math.floor(Date.now() / 1000), path: null, line: null });
  return pullView(findPull(path, number), path);
}

export async function commentPullRequestLine(path, number, comment) {
  await delay(300);
  if (!comment.body.trim()) throw { code: 'comment_empty', subject: null, message: 'empty' };
  const oldSide = comment.newLine === null;
  findPull(path, number).thread.push({
    id: String(Date.now()), author: accounts[0]?.username ?? 'me', body: comment.body, created: Math.floor(Date.now() / 1000),
    path: comment.path, line: oldSide ? comment.oldLine : comment.newLine, oldSide, outdated: false,
  });
  return pullView(findPull(path, number), path);
}

export async function replyPullRequestComment(path, number, reply) {
  await delay(300);
  if (!reply.body.trim()) throw { code: 'comment_empty', subject: null, message: 'empty' };
  findPull(path, number).thread.push({
    id: String(Date.now()), author: accounts[0]?.username ?? 'me', body: reply.body, created: Math.floor(Date.now() / 1000),
    path: null, line: null, parent: reply.to,
  });
  globalThis.mockReplies = [...(globalThis.mockReplies ?? []), reply];
  return pullView(findPull(path, number), path);
}

export async function mergePullRequest(path, number) {
  await delay(500);
  const pull = findPull(path, number);
  if (pull.draft) throw { code: 'hosting_http', subject: 'Pull request is in draft state', message: 'draft' };
  pull.state = 'merged';
  return pullView(pull, path);
}

export async function closePullRequest(path, number) {
  await delay(300);
  findPull(path, number).state = 'closed';
  return pullView(findPull(path, number), path);
}

export async function createPullRequest(path, pull) {
  await delay(500);
  if (!pull.title.trim()) throw { code: 'title_missing', subject: null, message: 'empty' };
  const list = pullsOf(path);
  const number = Math.max(0, ...list.map((p) => p.number)) + 1;
  const created = {
    number, title: pull.title, author: accounts[0]?.username ?? 'me', state: 'open', draft: pull.draft, sourceBranch: pull.sourceBranch,
    targetBranch: pull.targetBranch, sourceRepo: null, sourceCloneUrl: null, headOid: null, created: Math.floor(Date.now() / 1000),
    updated: Math.floor(Date.now() / 1000), webUrl: `https://github.com/steve-c/${nameOf(path)}/pull/${number}`, comments: 0, reviewers: [],
    reviewRequested: false, body: pull.body, thread: [],
  };
  list.unshift(created);
  const { body, thread, ...rest } = created;
  return structuredClone(rest);
}

/** Before `startup`, every repository counts as read. */
let everyRead = true;

export async function startup() {
  await delay(300);
  everyRead = false;
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

export async function refresh(path) {
  // « ?slow=1 » makes the first reading of each repository slow, as on a cold disk.
  const slow = !read.has(path) && new URLSearchParams(location.search).has('slow');
  await delay(slow ? 1500 : 250);
  for (const r of repositories) if (!path || r.path === path) read.add(r.path);
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
  const host = url.match(/^[^/@]+@([^:/]+):/)?.[1];
  if (host?.startsWith('ssh.') && !knownHosts.has(host)) throw { code: 'host_unknown', subject: host, message: `ssh does not know the server ${host} yet` };
  return folder;
}

/** ssh servers trusted in the design preview; those named « ssh.… » are unknown at first. */
const knownHosts = new Set();

export async function sshHostKeys(host) {
  await delay(600);
  return [
    { kind: 'ssh-ed25519', fingerprint: 'SHA256:ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM' },
    { kind: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:FC73VB6C4OQLSCrjEayhMp9UMxS97caD/Yyi2bhW/J0' },
  ];
}

export async function trustSshHost(host) {
  await delay(200);
  knownHosts.add(host);
  return 2;
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

export async function openInVsCode(path) {
  globalThis.mockVsCode = path;
}

export async function notify(title, body) {
  globalThis.mockNotified = [...(globalThis.mockNotified ?? []), { title, body }];
}

export async function about() {
  await delay(80);
  return {
    version: '1.0.0', authors: 'Steve Chadaud', license: 'MIT', git: '2.47.1', webview: '130.0.2849.80', tauri: '2.1.1',
    os: 'linux', arch: 'x86_64', dataDir: '/home/steve/.local/share/dev.ramelo.app',
  };
}

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

export async function history(path, limit, refs = null) {
  await delay(80);
  return repo.history(path, limit, refs);
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

export async function moveCommit(path, oid, direction) {
  await delay(200);
  globalThis.mockMoved = [oid, direction];
  return { head: oid, commit: oid, snapshot: snapshot() };
}

export async function applyPatches() {
  await delay(300);
  const applied = globalThis.mockApplied ?? { kind: 'commits', count: 2 };
  return { applied, snapshot: snapshot() };
}

export async function exportPatches(path, oids, summary) {
  await delay(200);
  globalThis.mockPatches = { oids, summary };
  const name = oids.length === 1 ? `0001-${(summary ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.patch` : `commits-${oids.length}.patch`;
  return { file: `${path}\\${name}`, count: oids.length, merges: 0 };
}

export async function squashCommits(path, oids) {
  await delay(300);
  globalThis.mockSquashed = oids;
  return { head: oids[0], commit: oids[0], snapshot: snapshot() };
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

export async function backgroundFetch(path) {
  await delay(600);
  return { moved: false, snapshot: null };
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

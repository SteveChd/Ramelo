// Tauri commands of `crates/gui/src/commands`: the Rust core does all the work.
// On failure, the promise rejects with { code, subject, message }.

const tauri = globalThis.__TAURI__;

export const available = Boolean(tauri?.core?.invoke);

const invoke = (command, args) => tauri.core.invoke(command, args);

// ---------- Workspace ----------
/** Workspace of the last session, with the state of every repository read again. */
export const listAccounts = () => invoke('list_accounts');
export const addAccount = (provider, url, login, token) => invoke('add_account', { provider, url, login, token });
export const checkAccount = (id) => invoke('check_account', { id });
export const removeAccount = (id) => invoke('remove_account', { id });
export const tokenPage = (provider, url) => invoke('token_page', { provider, url });
export const openUrl = (url) => invoke('open_url', { url });
export const repositoryHosting = (path) => invoke('repository_hosting', { path });
export const pullRequests = (path, openOnly = true) => invoke('pull_requests', { path, openOnly });
export const pullRequest = (path, number) => invoke('pull_request', { path, number });
export const pullRequestChanges = (path, number) => invoke('pull_request_changes', { path, number });
export const rangeFileDiff = (path, from, to, file) => invoke('range_file_diff', { path, from, to, file });
export const commentPullRequest = (path, number, body) => invoke('comment_pull_request', { path, number, body });
export const mergePullRequest = (path, number, method, message) => invoke('merge_pull_request', { path, number, method, message });
export const closePullRequest = (path, number) => invoke('close_pull_request', { path, number });
export const createPullRequest = (path, pull) => invoke('create_pull_request', { path, pull });
export const searchRepositories = (accountId, query, scope) => invoke('search_repositories', { accountId, query, scope });
export const repositoryReadme = (accountId, repo) => invoke('repository_readme', { accountId, repo });
export const startup = () => invoke('startup');
/** Reads again one repository, or all of them when `path` is null. */
export const refresh = (path = null) => invoke('refresh', { path });
/** Folder chooser: the chosen paths, or null if the user cancels. */
export const pickFolder = () => invoke('pick_folder');
/** Returns { snapshot, added, existing }; folders that are not repositories are searched. */
export const addRepositories = (paths) => invoke('add_repositories', { paths });
export const removeRepository = (path) => invoke('remove_repository', { path });
export const removeRepositories = (paths) => invoke('remove_repositories', { paths });
/** `path` null: the overview of all repositories. */
export const closeRepository = (path) => invoke('close_repository', { path });
/** Folder chooser for a clone, opened at `start`: the chosen path, or null. */
export const pickCloneFolder = (start) => invoke('pick_clone_folder', { start });
/**
 * Clones `url` into `folder` with { branch, submodules }; `onProgress({ phase, percent, detail })`
 * follows git. Resolves with the path of the clone.
 */
export function cloneRepository(url, folder, options, onProgress) {
  const progress = new tauri.core.Channel();
  progress.onmessage = onProgress;
  return invoke('clone_repository', { url, folder, options, progress });
}
export const cancelClone = () => invoke('cancel_clone');
/** The keys of an ssh server: [{ kind, fingerprint }]. */
export const sshHostKeys = (host) => invoke('ssh_host_keys', { host });
/** Adds the keys of `host` with these fingerprints to the known hosts. */
export const trustSshHost = (host, fingerprints) => invoke('trust_ssh_host', { host, fingerprints });
export const closeRepositories = (paths) => invoke('close_repositories', { paths });
export const setRepositoryPinned = (path, pinned) => invoke('set_repository_pinned', { path, pinned });
export const selectRepository = (path) => invoke('select_repository', { path });
export const reorderRepository = (path, index) => invoke('reorder_repository', { path, index });
/** `color`: « #rrggbb », or null for the automatic one. */
export const setRepositoryColor = (path, color) => invoke('set_repository_color', { path, color });
export const addSection = (name) => invoke('add_section', { name });
export const renameSection = (name, newName) => invoke('rename_section', { name, newName });
export const removeSection = (name) => invoke('remove_section', { name });
export const moveSection = (name, index) => invoke('move_section', { name, index });
export const setSectionCollapsed = (name, collapsed) => invoke('set_section_collapsed', { name, collapsed });
export const setRepositoriesSection = (paths, section) => invoke('set_repositories_section', { paths, section });
export const openFolder = (path) => invoke('open_folder', { path });

// ---------- One repository ----------
/** { rows: [{ oid, parents, author, email, time, summary, refs, graph }], width, hasMore }. */
export const history = (path, limit) => invoke('history', { path, limit });
/** { oid, parents, author, email, time, committer, commitTime, message, files: [FileDiff] }. */
/**
 * Commits of the whole history matching `query` { text, scope: 'all' | 'message' | 'author' | 'sha'
 * | 'file' | 'code', matchCase, regex }. Returns { oids (newest first), truncated }.
 */
export const searchCommits = (path, query, limit) => invoke('search_commits', { path, query, limit });
export const commitDetails = (path, oid) => invoke('commit_details', { path, oid });
/**
 * { editable, descendants, pushedTo: [remote branch], squash: { parent, pushedTo } | null } for a
 * commit to rewrite.
 */
export const rewriteInfo = (path, oid) => invoke('rewrite_info', { path, oid });
/** New message for a commit of the current branch: { head, commit, snapshot }. */
export const rewordCommit = (path, oid, message) => invoke('reword_commit', { path, oid, message });
/** New content for a file of a commit of the current branch: { head, commit, snapshot }. */
export const editCommitFile = (path, oid, file, content) => invoke('edit_commit_file', { path, oid, file, content });
/** Combines a commit with the one before it, with `message` or, when null, its message: { head, commit, snapshot }. */
/** Goes on with the operation in progress: { progress: 'done' | 'conflicts', snapshot }. */
export const continueOperation = (path) => invoke('continue_operation', { path });
/** Leaves out the commit a rebase or a cherry-pick stopped on: { progress, snapshot }. */
export const skipCommit = (path) => invoke('skip_commit', { path });
export const abortOperation = (path) => invoke('abort_operation', { path });
/**
 * A conflicted file: { path, ours, theirs, base, working, binary, segments: [{ kind: 'common', text }
 * | { kind: 'conflict', ours, base, theirs }], sides: { operation, ours, theirs: { name, oid, summary } } }.
 */
export const conflictFile = (path, file) => invoke('conflict_file', { path, file });
/** Marks a conflicted file resolved with `content`, or deleted when it is null: a snapshot. */
export const resolveConflict = (path, file, content) => invoke('resolve_conflict', { path, file, content });
/** Marks a conflicted file resolved with one side as it is: a snapshot. */
export const takeConflictSide = (path, file, theirs) => invoke('take_conflict_side', { path, file, theirs });
export const squashCommit = (path, oid, message) => invoke('squash_commit', { path, oid, message });
export const commitFileDiff = (path, oid, file) => invoke('commit_file_diff', { path, oid, file });
/** FileDiff { path, oldPath, status, binary, additions, deletions, hunks, truncated }, or null. */
/**
 * The file before and after a change: { before, after }, each { size, data (base64, null when too
 * large) } or null when the file does not exist on that side. `commit`: an oid, or null for the
 * working copy (`staged` or not).
 */
export const fileVersions = (path, file, oldPath, commit, staged, base = null) => invoke('file_versions', { path, file, oldPath, commit, staged, base });
export const fileDiff = (path, file, staged, untracked) => invoke('file_diff', { path, file, staged, untracked });
export const stage = (path, files) => invoke('stage', { path, files });
export const stageAll = (path) => invoke('stage_all', { path });
export const unstage = (path, files) => invoke('unstage', { path, files });
export const unstageAll = (path) => invoke('unstage_all', { path });
export const discard = (path, tracked, untracked) => invoke('discard', { path, tracked, untracked });
/** `action`: 'stage' | 'unstage' | 'discard'; `header`: the hunk as shown, checked by the backend. */
export const applyHunk = (path, file, untracked, index, header, action) => invoke('apply_hunk', { path, file, untracked, index, header, action });
/** Returns { snapshot, oid }. */
export const commit = (path, message, amend, stageAll) => invoke('commit', { path, message, amend, stageAll });
export const lastMessage = (path) => invoke('last_message', { path });
/** { local: [Branch], remote: [Branch], tags: [{ name, oid }] }. */
export const branches = (path) => invoke('branches', { path });
/** Returns { snapshot, carried: 'nothing' | 'reapplied' | 'conflicted' }. */
export const switchBranch = (path, target, carryChanges) => invoke('switch_branch', { path, target, carryChanges });
/** Returns { snapshot, carried }: the local changes follow when switching to the new branch. */
export const createBranch = (path, name, start, checkout) => invoke('create_branch', { path, name, start, checkout });
export const deleteBranch = (path, name, force) => invoke('delete_branch', { path, name, force });
export const fetch = (path) => invoke('fetch', { path });
/** `mode`: 'auto' | 'rebase' | 'merge'. Returns { snapshot, outcome: { kind, commits } }. */
export const pull = (path, mode) => invoke('pull', { path, mode });
/** Returns { snapshot, outcome: { remote, branch, upstreamSet } }. */
export const push = (path, force) => invoke('push', { path, force });

// ---------- Window and settings ----------
export const setLanguage = (language) => invoke('set_language', { language });
/** Shows the window, created hidden, once the splash screen is drawn. */
export const showWindow = () => invoke('show_window');

// ---------- Window events ----------
/** Folders dropped onto the window: `listener(paths)`; `onHover(true | false)` while dragging. */
export function onFoldersDropped(listener, onHover) {
  tauri.event.listen('tauri://drag-enter', () => onHover(true));
  tauri.event.listen('tauri://drag-leave', () => onHover(false));
  tauri.event.listen('tauri://drag-drop', (e) => {
    onHover(false);
    if (e.payload?.paths?.length) listener(e.payload.paths);
  });
}

// Tauri commands of `crates/gui/src/commands`: the Rust core does all the work.
// On failure, the promise rejects with { code, subject, message }.

const tauri = globalThis.__TAURI__;

export const available = Boolean(tauri?.core?.invoke);

const invoke = (command, args) => tauri.core.invoke(command, args);

// ---------- Workspace ----------
/** Workspace of the last session, with the state of every repository read again. */
export const startup = () => invoke('startup');
/** Reads again one repository, or all of them when `path` is null. */
export const refresh = (path = null) => invoke('refresh', { path });
/** Folder chooser: the chosen paths, or null if the user cancels. */
export const pickFolder = () => invoke('pick_folder');
/** Returns { snapshot, added, existing }; folders that are not repositories are searched. */
export const addRepositories = (paths) => invoke('add_repositories', { paths });
export const removeRepository = (path) => invoke('remove_repository', { path });
/** `path` null: the overview of all repositories. */
export const selectRepository = (path) => invoke('select_repository', { path });
export const reorderRepository = (path, index) => invoke('reorder_repository', { path, index });
/** `color`: « #rrggbb », or null for the automatic one. */
export const setRepositoryColor = (path, color) => invoke('set_repository_color', { path, color });
export const openFolder = (path) => invoke('open_folder', { path });

// ---------- One repository ----------
/** { rows: [{ oid, parents, author, email, time, summary, refs, graph }], width, hasMore }. */
export const history = (path, limit) => invoke('history', { path, limit });
/** { oid, parents, author, email, time, committer, commitTime, message, files: [FileDiff] }. */
export const commitDetails = (path, oid) => invoke('commit_details', { path, oid });
export const commitFileDiff = (path, oid, file) => invoke('commit_file_diff', { path, oid, file });
/** FileDiff { path, oldPath, status, binary, additions, deletions, hunks, truncated }, or null. */
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

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
export const openFolder = (path) => invoke('open_folder', { path });

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

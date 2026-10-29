//! The workspace: adding, removing, ordering and selecting repositories, and reading their state.
//!
//! Commands that run git are `async`: Tauri then runs them outside the main thread, so the window
//! stays responsive while a large workspace is read.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use std::sync::atomic::Ordering;

use ramelo_core::{CloneOptions, CloneProgress, GitError, ScanLimits};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{CommandError, CommandResult};
use crate::snapshot::Snapshot;
use crate::state::AppState;

/// Workspace saved at the last session; the state of every repository is read again.
#[tauri::command]
pub async fn startup(state: State<'_, AppState>) -> CommandResult<Snapshot> {
    state.refresh(&state.repository_paths());
    Ok(state.snapshot())
}

/// Reads again one repository, or all of them when `path` is `None`.
#[tauri::command]
pub async fn refresh(state: State<'_, AppState>, path: Option<String>) -> CommandResult<Snapshot> {
    let paths = match path {
        Some(path) => vec![PathBuf::from(path)],
        None => state.repository_paths(),
    };
    state.refresh(&paths);
    Ok(state.snapshot())
}

/// Lets the user choose one or more folders; `None` if the dialog is cancelled.
#[tauri::command]
pub fn pick_folder(state: State<'_, AppState>) -> Option<Vec<String>> {
    let title = if state.language() == "fr" { "Ajouter des dépôts" } else { "Add repositories" };
    rfd::FileDialog::new()
        .set_title(title)
        .pick_folders()
        .map(|folders| folders.iter().map(|f| f.display().to_string()).collect())
}

/// Folder chooser for the folder a repository is cloned into; `start` is where it opens.
#[tauri::command]
pub fn pick_clone_folder(state: State<'_, AppState>, start: Option<String>) -> Option<String> {
    let title = if state.language() == "fr" { "Dossier où cloner" } else { "Folder to clone into" };
    let mut dialog = rfd::FileDialog::new().set_title(title);
    if let Some(start) = start.filter(|s| Path::new(s).is_dir()) {
        dialog = dialog.set_directory(start);
    }
    dialog.pick_folder().map(|f| f.display().to_string())
}

/// Clones `url` into `folder` (which must not exist or be empty), sending git's progress on
/// `progress`; returns the path of the clone, to add to the workspace.
#[tauri::command]
pub async fn clone_repository(
    state: State<'_, AppState>,
    url: String,
    folder: String,
    options: CloneOptions,
    progress: Channel<CloneProgress>,
) -> CommandResult<String> {
    state.clone_cancelled.store(false, Ordering::SeqCst);
    let cancelled = || state.clone_cancelled.load(Ordering::SeqCst);
    let path = ramelo_core::clone(&state.git, &url, Path::new(&folder), &options, |p| {
        let _ = progress.send(p);
    }, &cancelled).map_err(|e| crate::commands::ssh::name_host_of(e, &url))?;
    Ok(path.display().to_string())
}

/// Stops the clone in progress; the folder it started is removed.
#[tauri::command]
pub fn cancel_clone(state: State<'_, AppState>) {
    state.clone_cancelled.store(true, Ordering::SeqCst);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub snapshot: Snapshot,
    /// Repositories that were not in the workspace yet.
    pub added: Vec<String>,
    /// Repositories found that were already there.
    pub existing: usize,
}

/// Adds the repositories found in `paths`: a folder inside a repository adds that repository; any
/// other folder is searched for the repositories it contains (a folder of projects, a git-repo
/// workspace…). The first repository found becomes the active tab.
#[tauri::command]
pub async fn add_repositories(state: State<'_, AppState>, paths: Vec<String>) -> CommandResult<AddResult> {
    let mut found = Vec::new();
    let mut first_error = None;
    for path in &paths {
        match find_repositories(&state, Path::new(path)) {
            Ok(roots) => found.extend(roots),
            Err(error) => first_error = first_error.or(Some(error)),
        }
    }
    if found.is_empty() {
        return Err(first_error.unwrap_or_else(|| CommandError::new("no_repository_found", None, "no repository was found")));
    }
    let mut seen = HashSet::new();
    found.retain(|root| seen.insert(root.clone()));

    let (added, existing) = state.edit_workspace(|workspace| {
        let added: Vec<PathBuf> = found.iter().filter(|root| workspace.add((*root).clone())).cloned().collect();
        workspace.active = Some(found[0].clone());
        let existing = found.len() - added.len();
        (added, existing)
    })?;
    state.refresh(&added);
    Ok(AddResult { snapshot: state.snapshot(), added: added.iter().map(|p| p.display().to_string()).collect(), existing })
}

fn find_repositories(state: &AppState, path: &Path) -> CommandResult<Vec<PathBuf>> {
    match ramelo_core::open(&state.git, path) {
        Ok(location) => Ok(vec![location.root]),
        Err(GitError::NotARepository(_)) => {
            let roots = ramelo_core::scan(path, ScanLimits::default());
            if roots.is_empty() {
                Err(GitError::NoRepositoryFound(path.to_path_buf()).into())
            } else {
                Ok(roots)
            }
        }
        Err(error) => Err(error.into()),
    }
}

/// Removes a repository from the workspace; its folder on disk is not touched.
#[tauri::command]
pub fn remove_repository(state: State<'_, AppState>, path: String) -> CommandResult<Snapshot> {
    let path = PathBuf::from(path);
    state.edit_workspace(|workspace| workspace.remove(&path))?;
    state.forget(&path);
    Ok(state.snapshot())
}

/// Removes several repositories from the workspace; their folders on disk are not touched.
#[tauri::command]
pub fn remove_repositories(state: State<'_, AppState>, paths: Vec<String>) -> CommandResult<Snapshot> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    state.edit_workspace(|workspace| workspace.remove_many(&paths))?;
    for path in &paths {
        state.forget(path);
    }
    Ok(state.snapshot())
}

/// Closes the tab of a repository; it stays in the overview.
#[tauri::command]
pub fn close_repository(state: State<'_, AppState>, path: String) -> CommandResult<Snapshot> {
    state.edit_workspace(|workspace| workspace.close(Path::new(&path)))?;
    Ok(state.snapshot())
}

/// Closes several tabs at once (close the others, close all); the repositories stay in the overview.
#[tauri::command]
pub fn close_repositories(state: State<'_, AppState>, paths: Vec<String>) -> CommandResult<Snapshot> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    state.edit_workspace(|workspace| workspace.close_many(&paths))?;
    Ok(state.snapshot())
}

/// Pins a tab at the start of the tabs, or unpins it.
#[tauri::command]
pub fn set_repository_pinned(state: State<'_, AppState>, path: String, pinned: bool) -> CommandResult<Snapshot> {
    state.edit_workspace(|workspace| workspace.set_pinned(Path::new(&path), pinned))?;
    Ok(state.snapshot())
}

/// Shows a repository (`None`: the overview of all repositories), opening its tab again if it was
/// closed. Its state is read again, so that a tab always opens on fresh information.
#[tauri::command]
pub async fn select_repository(state: State<'_, AppState>, path: Option<String>) -> CommandResult<Snapshot> {
    let path = path.map(PathBuf::from);
    state.edit_workspace(|workspace| {
        if let Some(p) = &path {
            workspace.open(p);
        }
        workspace.active = path.clone().filter(|p| workspace.contains(p));
    })?;
    if let Some(path) = path {
        state.refresh(&[path]);
    }
    state.refresh_unknown();
    Ok(state.snapshot())
}

/// Moves a tab to position `index`.
#[tauri::command]
pub fn reorder_repository(state: State<'_, AppState>, path: String, index: usize) -> CommandResult<Snapshot> {
    state.edit_workspace(|workspace| workspace.reorder(Path::new(&path), index))?;
    Ok(state.snapshot())
}

/// Sets the colour of a repository: « #rrggbb », or `None` for the automatic one.
#[tauri::command]
pub fn set_repository_color(state: State<'_, AppState>, path: String, color: Option<String>) -> CommandResult<Snapshot> {
    let color = color.map(|c| c.to_ascii_lowercase());
    if let Some(c) = &color {
        let valid = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
        if !valid {
            return Err(CommandError::new("invalid_color", Some(c.clone()), "a colour is written #rrggbb"));
        }
    }
    state.edit_workspace(|workspace| workspace.set_color(Path::new(&path), color))?;
    Ok(state.snapshot())
}

fn section_taken(name: &str) -> CommandError {
    CommandError::new("section_exists", Some(name.trim().to_owned()), "a section already has this name, or the name is empty")
}

/// Adds an empty section at the end of the overview.
#[tauri::command]
pub fn add_section(state: State<'_, AppState>, name: String) -> CommandResult<Snapshot> {
    if !state.edit_workspace(|workspace| workspace.add_section(&name))? {
        return Err(section_taken(&name));
    }
    Ok(state.snapshot())
}

/// Renames a section; its repositories follow.
#[tauri::command]
pub fn rename_section(state: State<'_, AppState>, name: String, new_name: String) -> CommandResult<Snapshot> {
    if !state.edit_workspace(|workspace| workspace.rename_section(&name, &new_name))? {
        return Err(section_taken(&new_name));
    }
    Ok(state.snapshot())
}

/// Removes a section; its repositories go back with those in no section.
#[tauri::command]
pub fn remove_section(state: State<'_, AppState>, name: String) -> CommandResult<Snapshot> {
    state.edit_workspace(|workspace| workspace.remove_section(&name))?;
    Ok(state.snapshot())
}

/// Moves a section to position `index`.
#[tauri::command]
pub fn move_section(state: State<'_, AppState>, name: String, index: usize) -> CommandResult<Snapshot> {
    state.edit_workspace(|workspace| workspace.move_section(&name, index))?;
    Ok(state.snapshot())
}

/// Folds or unfolds a section (`None`: the repositories in no section).
#[tauri::command]
pub fn set_section_collapsed(state: State<'_, AppState>, name: Option<String>, collapsed: bool) -> CommandResult<Snapshot> {
    state.edit_workspace(|workspace| workspace.set_section_collapsed(name.as_deref(), collapsed))?;
    Ok(state.snapshot())
}

/// Files repositories under a section, created if needed (`None`: under no section).
#[tauri::command]
pub fn set_repositories_section(state: State<'_, AppState>, paths: Vec<String>, section: Option<String>) -> CommandResult<Snapshot> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    state.edit_workspace(|workspace| workspace.set_section(&paths, section.as_deref()))?;
    Ok(state.snapshot())
}

/// Opens the folder in the system file manager.
#[tauri::command]
pub fn open_folder(path: String) -> CommandResult<()> {
    open::that_detached(&path).map_err(|e| CommandError::new("open_failed", Some(path), e.to_string()))
}

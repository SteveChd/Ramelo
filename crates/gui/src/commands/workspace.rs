//! The workspace: adding, removing, ordering and selecting repositories, and reading their state.
//!
//! Commands that run git are `async`: Tauri then runs them outside the main thread, so the window
//! stays responsive while a large workspace is read.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use gitcontroller_core::{GitError, ScanLimits};
use serde::Serialize;
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
    match gitcontroller_core::open(&state.git, path) {
        Ok(location) => Ok(vec![location.root]),
        Err(GitError::NotARepository(_)) => {
            let roots = gitcontroller_core::scan(path, ScanLimits::default());
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

/// Shows a repository (`None`: the overview of all repositories). Its state is read again, so that a
/// tab always opens on fresh information.
#[tauri::command]
pub async fn select_repository(state: State<'_, AppState>, path: Option<String>) -> CommandResult<Snapshot> {
    let path = path.map(PathBuf::from);
    state.edit_workspace(|workspace| {
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

/// Opens the folder in the system file manager.
#[tauri::command]
pub fn open_folder(path: String) -> CommandResult<()> {
    open::that_detached(&path).map_err(|e| CommandError::new("open_failed", Some(path), e.to_string()))
}

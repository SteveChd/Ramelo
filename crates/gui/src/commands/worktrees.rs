//! The worktrees of a repository. A tab shows one worktree at a time: switching to another one makes
//! the same tab show its folder, instead of opening a tab of its own.

use std::path::PathBuf;

use ramelo_core::{worktrees, WorktreeInfo, WorktreeTarget};
use tauri::State;

use crate::error::{CommandError, CommandResult};
use crate::snapshot::Snapshot;
use crate::state::AppState;

/// The worktrees of the repository of `path`, the main one first.
#[tauri::command]
pub async fn worktrees(state: State<'_, AppState>, path: String) -> CommandResult<Vec<WorktreeInfo>> {
    Ok(worktrees::list(&state.git, &PathBuf::from(path))?)
}

/// The tab of `path` shows the worktree of `folder` from now on.
#[tauri::command]
pub async fn switch_worktree(state: State<'_, AppState>, path: String, folder: String) -> CommandResult<Snapshot> {
    retarget(&state, PathBuf::from(path), PathBuf::from(folder))
}

fn retarget(state: &AppState, from: PathBuf, folder: PathBuf) -> CommandResult<Snapshot> {
    let to = ramelo_core::open(&state.git, &folder)?.root;
    let done = state.edit_workspace(|workspace| workspace.retarget(&from, to.clone()))?;
    if !done {
        return Err(CommandError::new("not_in_workspace", Some(from.display().to_string()), "the repository is not in the workspace"));
    }
    state.refresh(&[to]);
    Ok(state.snapshot())
}

/// Creates a worktree in `folder`; with `open`, the tab of `path` shows it at once.
#[tauri::command]
pub async fn add_worktree(state: State<'_, AppState>, path: String, folder: String, target: WorktreeTarget, open: bool) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    let created = worktrees::add(&state.git, &root, &PathBuf::from(folder), &target)?;
    if open {
        return retarget(&state, root, created);
    }
    state.refresh(&[root]);
    Ok(state.snapshot())
}

/// Removes the worktree of `folder` (its folder is deleted, its branch stays). A tab of its own in the
/// workspace goes with it.
#[tauri::command]
pub async fn remove_worktree(state: State<'_, AppState>, path: String, folder: String, force: bool) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    let folder = PathBuf::from(folder);
    worktrees::remove(&state.git, &root, &folder, force)?;
    if state.workspace().contains(&folder) {
        state.edit_workspace(|workspace| workspace.remove(&folder))?;
        state.forget(&folder);
    }
    state.refresh(&[root]);
    Ok(state.snapshot())
}

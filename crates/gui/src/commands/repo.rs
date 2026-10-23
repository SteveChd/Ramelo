//! One repository: history and graph, diffs, staging and commits, branches, and exchanges with the
//! remotes. Every change returns a fresh snapshot, so that the tabs and the overview stay in step.

use std::path::PathBuf;

use gitcontroller_core::{self as core, refs, Carried, Commit, CommitDetails, FileDiff, GraphRow, HunkAction, PullMode, PullOutcome, PushOutcome, RefList};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{CommandError, CommandResult};
use crate::snapshot::Snapshot;
use crate::state::AppState;

/// Reads the repository again after a change and returns the new snapshot.
fn changed(state: &AppState, root: PathBuf) -> Snapshot {
    state.refresh(&[root]);
    state.snapshot()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    #[serde(flatten)]
    pub commit: Commit,
    pub graph: GraphRow,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub rows: Vec<HistoryRow>,
    /// Number of lanes of the graph.
    pub width: usize,
    /// More commits exist beyond `limit`.
    pub has_more: bool,
}

/// The `limit` most recent commits of all branches, with the layout of the graph. The graph is laid
/// out from the first commit each time, so that loading more never shifts the lanes already shown.
#[tauri::command]
pub async fn history(state: State<'_, AppState>, path: String, limit: usize) -> CommandResult<History> {
    let mut commits = core::log(&state.git, &PathBuf::from(path), limit + 1, 0)?;
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    let (graph, width) = core::layout(&commits);
    let rows = commits.into_iter().zip(graph).map(|(commit, graph)| HistoryRow { commit, graph }).collect();
    Ok(History { rows, width, has_more })
}

#[tauri::command]
pub async fn commit_details(state: State<'_, AppState>, path: String, oid: String) -> CommandResult<CommitDetails> {
    Ok(core::commit_details(&state.git, &PathBuf::from(path), &oid)?)
}

/// One file of a commit, in full.
#[tauri::command]
pub async fn commit_file_diff(state: State<'_, AppState>, path: String, oid: String, file: String) -> CommandResult<Option<FileDiff>> {
    Ok(core::commit_file_diff(&state.git, &PathBuf::from(path), &oid, &file)?)
}

/// Changes of a working-copy file: staged ones, or not staged yet (`untracked`: a new file).
#[tauri::command]
pub async fn file_diff(state: State<'_, AppState>, path: String, file: String, staged: bool, untracked: bool) -> CommandResult<Option<FileDiff>> {
    Ok(core::worktree_diff(&state.git, &PathBuf::from(path), &file, staged, untracked)?)
}

#[tauri::command]
pub async fn stage(state: State<'_, AppState>, path: String, files: Vec<String>) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    core::stage(&state.git, &root, &files)?;
    Ok(changed(&state, root))
}

#[tauri::command]
pub async fn stage_all(state: State<'_, AppState>, path: String) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    core::stage_all(&state.git, &root)?;
    Ok(changed(&state, root))
}

#[tauri::command]
pub async fn unstage(state: State<'_, AppState>, path: String, files: Vec<String>) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    core::unstage(&state.git, &root, &files)?;
    Ok(changed(&state, root))
}

#[tauri::command]
pub async fn unstage_all(state: State<'_, AppState>, path: String) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    core::unstage_all(&state.git, &root)?;
    Ok(changed(&state, root))
}

/// Throws away the unstaged changes of `tracked` files and deletes the `untracked` ones.
#[tauri::command]
pub async fn discard(state: State<'_, AppState>, path: String, tracked: Vec<String>, untracked: Vec<String>) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    core::discard(&state.git, &root, &tracked, &untracked)?;
    Ok(changed(&state, root))
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HunkActionArg {
    Stage,
    Unstage,
    Discard,
}

/// Stages, unstages or discards hunk `index` of a file. `header` is the hunk the user saw: if the
/// file changed since, nothing is done and the interface shows the new diff.
#[tauri::command]
pub async fn apply_hunk(
    state: State<'_, AppState>,
    path: String,
    file: String,
    untracked: bool,
    index: usize,
    header: String,
    action: HunkActionArg,
) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    let action = match action {
        HunkActionArg::Stage => HunkAction::Stage,
        HunkActionArg::Unstage => HunkAction::Unstage,
        HunkActionArg::Discard => HunkAction::Discard,
    };
    let diff = core::worktree_diff(&state.git, &root, &file, action == HunkAction::Unstage, untracked)?;
    let patch = diff
        .filter(|d| d.hunks.get(index).is_some_and(|h| h.header == header))
        .and_then(|d| d.hunk_patch(index))
        .ok_or_else(|| CommandError::new("diff_changed", Some(file.clone()), "the file changed since its diff was shown"))?;
    core::apply_hunk(&state.git, &root, &patch, action)?;
    Ok(changed(&state, root))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub snapshot: Snapshot,
    pub oid: String,
}

/// Commits the staged changes (`stage_all`: everything, staged or not). With `amend`, the last commit
/// is replaced.
#[tauri::command]
pub async fn commit(state: State<'_, AppState>, path: String, message: String, amend: bool, stage_all: bool) -> CommandResult<CommitResult> {
    let root = PathBuf::from(path);
    if message.trim().is_empty() {
        return Err(CommandError::new("empty_message", None, "a commit needs a message"));
    }
    if stage_all {
        core::stage_all(&state.git, &root)?;
    }
    let result = core::commit(&state.git, &root, &message, amend);
    // Even when the commit fails (a hook refused it…), what was staged must show.
    let snapshot = changed(&state, root);
    Ok(CommitResult { oid: result?, snapshot })
}

/// Message of the last commit, to edit when amending.
#[tauri::command]
pub async fn last_message(state: State<'_, AppState>, path: String) -> CommandResult<Option<String>> {
    Ok(core::last_message(&state.git, &PathBuf::from(path))?)
}

#[tauri::command]
pub async fn branches(state: State<'_, AppState>, path: String) -> CommandResult<RefList> {
    Ok(refs::list(&state.git, &PathBuf::from(path))?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    pub snapshot: Snapshot,
    pub carried: Carried,
}

/// Switches to a branch, a remote branch or a commit; `carry_changes` brings the local changes along.
#[tauri::command]
pub async fn switch_branch(state: State<'_, AppState>, path: String, target: String, carry_changes: bool) -> CommandResult<SwitchResult> {
    let root = PathBuf::from(path);
    let result = refs::switch(&state.git, &root, &target, carry_changes);
    let snapshot = changed(&state, root);
    Ok(SwitchResult { carried: result?, snapshot })
}

/// Creates a branch at `start` (HEAD when `None`); with `checkout`, switches to it and brings the
/// local changes along.
#[tauri::command]
pub async fn create_branch(state: State<'_, AppState>, path: String, name: String, start: Option<String>, checkout: bool) -> CommandResult<SwitchResult> {
    let root = PathBuf::from(path);
    let result = refs::create(&state.git, &root, name.trim(), start.as_deref(), checkout);
    let snapshot = changed(&state, root);
    Ok(SwitchResult { carried: result?, snapshot })
}

#[tauri::command]
pub async fn delete_branch(state: State<'_, AppState>, path: String, name: String, force: bool) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    refs::delete(&state.git, &root, &name, force)?;
    Ok(changed(&state, root))
}

#[tauri::command]
pub async fn fetch(state: State<'_, AppState>, path: String) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    core::fetch(&state.git, &root)?;
    Ok(changed(&state, root))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub snapshot: Snapshot,
    pub outcome: PullOutcome,
}

/// `mode`: « auto » fast-forwards only, « rebase » or « merge » when the branch has diverged.
#[tauri::command]
pub async fn pull(state: State<'_, AppState>, path: String, mode: PullMode) -> CommandResult<PullResult> {
    let root = PathBuf::from(path);
    let result = core::pull(&state.git, &root, mode);
    // A pull that stops on conflicts still changed the repository.
    let snapshot = changed(&state, root);
    Ok(PullResult { outcome: result?, snapshot })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub snapshot: Snapshot,
    pub outcome: PushOutcome,
}

#[tauri::command]
pub async fn push(state: State<'_, AppState>, path: String, force: bool) -> CommandResult<PushResult> {
    let root = PathBuf::from(path);
    let outcome = core::push(&state.git, &root, force)?;
    Ok(PushResult { outcome, snapshot: changed(&state, root) })
}

//! One repository: history and graph, diffs, staging and commits, branches, and exchanges with the
//! remotes. Every change returns a fresh snapshot, so that the tabs and the overview stay in step.

use std::path::PathBuf;

use base64::Engine;
use ramelo_core::{self as core, refs, Carried, ConflictFile, Progress, Content, RewriteInfo, Rewritten, SearchQuery, SearchResult, Version, Commit, CommitDetails, FileDiff, GraphRow, HunkAction, PullMode, PullOutcome, PushOutcome, RefList};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::ssh::name_host;
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

/// The `limit` most recent commits of all branches, or of `refs` only (full names), with the layout
/// of the graph. The graph is laid out from the first commit each time, so that loading more never
/// shifts the lanes already shown.
#[tauri::command]
pub async fn history(state: State<'_, AppState>, path: String, limit: usize, refs: Option<Vec<String>>) -> CommandResult<History> {
    let mut commits = core::log_of(&state.git, &PathBuf::from(path), refs.as_deref(), limit + 1, 0)?;
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    let (graph, width) = core::layout(&commits);
    let rows = commits.into_iter().zip(graph).map(|(commit, graph)| HistoryRow { commit, graph }).collect();
    Ok(History { rows, width, has_more })
}

/// Commits of the whole history that match `query`, newest first (at most `limit`).
#[tauri::command]
pub async fn search_commits(state: State<'_, AppState>, path: String, query: SearchQuery, limit: usize) -> CommandResult<SearchResult> {
    Ok(core::search(&state.git, &PathBuf::from(path), &query, limit)?)
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

/// One version of a file, for an image or a preview.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub size: u64,
    /// The content in base64; `None` when the file is too large to be shown.
    pub data: Option<String>,
}

impl From<Content> for FileVersion {
    fn from(content: Content) -> Self {
        Self { size: content.size, data: content.bytes.map(|b| base64::engine::general_purpose::STANDARD.encode(b)) }
    }
}

/// The file before and after the change shown in a diff; either side is `None` when the file does
/// not exist there (added or deleted).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersions {
    pub before: Option<FileVersion>,
    pub after: Option<FileVersion>,
}

/// `commit`: the change made by that commit (compared with its first parent). Otherwise the working
/// copy: the staged change (`staged`) or the one not staged yet.
#[tauri::command]
pub async fn file_versions(
    state: State<'_, AppState>,
    path: String,
    file: String,
    old_path: Option<String>,
    commit: Option<String>,
    staged: bool,
    base: Option<String>,
) -> CommandResult<FileVersions> {
    let root = PathBuf::from(path);
    // A range (a pull request) starts from its base; a commit, from its parent.
    let parent = commit.as_ref().map(|oid| base.clone().unwrap_or_else(|| format!("{oid}^")));
    let (before, after) = match (&commit, &parent) {
        (Some(oid), Some(parent)) => (Version::Revision(parent), Version::Revision(oid)),
        _ if staged => (Version::Revision("HEAD"), Version::Index),
        _ => (Version::Index, Version::Worktree),
    };
    let read = |file: &str, version| core::file_content(&state.git, &root, file, version).map(|c| c.map(FileVersion::from));
    Ok(FileVersions { before: read(old_path.as_deref().unwrap_or(&file), before)?, after: read(&file, after)? })
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

/// Whether a past commit can be rewritten, how many commits follow it, and where it was pushed.
#[tauri::command]
pub async fn rewrite_info(state: State<'_, AppState>, path: String, oid: String) -> CommandResult<RewriteInfo> {
    Ok(core::rewrite_info(&state.git, &PathBuf::from(path), &oid)?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteResult {
    #[serde(flatten)]
    pub rewritten: Rewritten,
    pub snapshot: Snapshot,
}

/// Gives a commit of the current branch a new message; the commits after it are written again.
#[tauri::command]
pub async fn reword_commit(state: State<'_, AppState>, path: String, oid: String, message: String) -> CommandResult<RewriteResult> {
    let root = PathBuf::from(path);
    if message.trim().is_empty() {
        return Err(CommandError::new("empty_message", None, "a commit needs a message"));
    }
    let rewritten = core::reword(&state.git, &root, &oid, &message)?;
    Ok(RewriteResult { rewritten, snapshot: changed(&state, root) })
}

/// Replaces a file's content in a commit of the current branch; the commits after it keep their own
/// changes to the file.
#[tauri::command]
pub async fn edit_commit_file(state: State<'_, AppState>, path: String, oid: String, file: String, content: String) -> CommandResult<RewriteResult> {
    let root = PathBuf::from(path);
    let rewritten = core::edit_file(&state.git, &root, &oid, &file, content.as_bytes())?;
    Ok(RewriteResult { rewritten, snapshot: changed(&state, root) })
}

/// Combines a commit of the current branch with the one before it: with `message` (squash), or with
/// the message of the one before it when there is none (fixup).
#[tauri::command]
pub async fn squash_commit(state: State<'_, AppState>, path: String, oid: String, message: Option<String>) -> CommandResult<RewriteResult> {
    let root = PathBuf::from(path);
    let rewritten = core::squash(&state.git, &root, &oid, message.as_deref())?;
    Ok(RewriteResult { rewritten, snapshot: changed(&state, root) })
}

/// Combines commits of the current branch that follow one another into the oldest of them: with
/// `message` (squash), or with the message of the oldest when there is none (fixup).
#[tauri::command]
pub async fn squash_commits(state: State<'_, AppState>, path: String, oids: Vec<String>, message: Option<String>) -> CommandResult<RewriteResult> {
    let root = PathBuf::from(path);
    let rewritten = core::squash_many(&state.git, &root, &oids, message.as_deref())?;
    Ok(RewriteResult { rewritten, snapshot: changed(&state, root) })
}

/// Moves a commit of the current branch one place up or down, swapping it with its neighbour.
#[tauri::command]
pub async fn move_commit(state: State<'_, AppState>, path: String, oid: String, direction: core::Direction) -> CommandResult<RewriteResult> {
    let root = PathBuf::from(path);
    let rewritten = core::move_commit(&state.git, &root, &oid, direction)?;
    Ok(RewriteResult { rewritten, snapshot: changed(&state, root) })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressResult {
    pub progress: Progress,
    pub snapshot: Snapshot,
}

/// Goes on with the merge, rebase, cherry-pick or revert in progress once its conflicts are resolved.
#[tauri::command]
pub async fn continue_operation(state: State<'_, AppState>, path: String) -> CommandResult<ProgressResult> {
    let root = PathBuf::from(path);
    let progress = core::continue_operation(&state.git, &root);
    let snapshot = changed(&state, root);
    Ok(ProgressResult { progress: progress?, snapshot })
}

/// Leaves out the commit a rebase or a cherry-pick stopped on.
#[tauri::command]
pub async fn skip_commit(state: State<'_, AppState>, path: String) -> CommandResult<ProgressResult> {
    let root = PathBuf::from(path);
    let progress = core::skip_commit(&state.git, &root);
    let snapshot = changed(&state, root);
    Ok(ProgressResult { progress: progress?, snapshot })
}

/// Gives up the operation in progress.
#[tauri::command]
pub async fn abort_operation(state: State<'_, AppState>, path: String) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    core::abort_operation(&state.git, &root)?;
    Ok(changed(&state, root))
}

/// The versions of a conflicted file, for the conflict editor.
#[tauri::command]
pub async fn conflict_file(state: State<'_, AppState>, path: String, file: String) -> CommandResult<ConflictFile> {
    Ok(core::conflict_file(&state.git, &PathBuf::from(path), &file)?)
}

/// Marks a conflicted file resolved with `content`, or deleted when there is none.
#[tauri::command]
pub async fn resolve_conflict(state: State<'_, AppState>, path: String, file: String, content: Option<String>) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    core::resolve_file(&state.git, &root, &file, content.as_deref().map(str::as_bytes))?;
    Ok(changed(&state, root))
}

/// Marks a conflicted file resolved with one side as it is (`theirs`, or ours).
#[tauri::command]
pub async fn take_conflict_side(state: State<'_, AppState>, path: String, file: String, theirs: bool) -> CommandResult<Snapshot> {
    let root = PathBuf::from(path);
    core::take_side(&state.git, &root, &file, theirs)?;
    Ok(changed(&state, root))
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
pub async fn switch_branch(state: State<'_, AppState>, path: String, target: String, detach: Option<bool>, carry_changes: bool) -> CommandResult<SwitchResult> {
    let root = PathBuf::from(path);
    let result = refs::switch(&state.git, &root, &target, detach.unwrap_or(false), carry_changes);
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
    core::fetch(&state.git, &root).map_err(|e| name_host(&state, e, &root))?;
    Ok(changed(&state, root))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundFetch {
    /// Whether a remote branch or a tag changed; when not, the snapshot is null (nothing to read again).
    pub moved: bool,
    pub snapshot: Option<Snapshot>,
}

/// A fetch started by the periodic refresh: it never asks anything, and a failure (offline, server
/// not trusted yet, credentials missing) is left to the next manual fetch to explain.
#[tauri::command]
pub async fn background_fetch(state: State<'_, AppState>, path: String) -> CommandResult<BackgroundFetch> {
    let root = PathBuf::from(path);
    let moved = core::fetch_in_background(&state.git, &root).map_err(|e| name_host(&state, e, &root))?;
    Ok(BackgroundFetch { moved, snapshot: moved.then(|| changed(&state, root)) })
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
    let result = core::pull(&state.git, &root, mode).map_err(|e| name_host(&state, e, &root));
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
/// `upto`: push the commits of the branch only up to this one.
pub async fn push(state: State<'_, AppState>, path: String, force: bool, upto: Option<String>) -> CommandResult<PushResult> {
    let root = PathBuf::from(path);
    let outcome = core::push(&state.git, &root, force, upto.as_deref()).map_err(|e| name_host(&state, e, &root))?;
    Ok(PushResult { outcome, snapshot: changed(&state, root) })
}

/// Where the patches of some commits were written.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchExport {
    pub file: String,
    pub count: usize,
    /// Merge commits left out.
    pub merges: usize,
}

/// Writes the patches of `oids` (the oldest first) into one `.patch` file the user chooses, which
/// `git am` applies elsewhere. `summary`: the summary of the commit when there is only one, to name
/// the file as git would. `None` when the dialog is cancelled.
#[tauri::command]
pub async fn export_patches(state: State<'_, AppState>, path: String, oids: Vec<String>, summary: Option<String>) -> CommandResult<Option<PatchExport>> {
    let root = PathBuf::from(&path);
    let set = core::format_patches(&state.git, &root, &oids)?;
    if set.count == 0 {
        return Err(CommandError::new("nothing_to_export", None, "the commits chosen are all merges: there is no patch to write"));
    }
    let name = match summary.filter(|_| set.count == 1) {
        Some(summary) => core::patch_file_name(&summary),
        None => {
            let repo = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "commits".to_owned());
            format!("{repo}-{}-commits.patch", set.count)
        }
    };
    let fr = state.language() == "fr";
    let file = rfd::FileDialog::new()
        .set_title(if fr { "Exporter en patch" } else { "Export as a patch" })
        .set_directory(&root)
        .set_file_name(name)
        .add_filter("Patch", &["patch", "diff"])
        .save_file();
    let Some(file) = file else { return Ok(None) };
    std::fs::write(&file, set.text.as_bytes())
        .map_err(|e| CommandError::new("write_failed", Some(file.display().to_string()), e.to_string()))?;
    Ok(Some(PatchExport { file: file.display().to_string(), count: set.count, merges: set.merges.len() }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchImport {
    pub applied: core::Applied,
    pub snapshot: Snapshot,
}

/// Lets the user choose patch files and applies them, in the order of their names (0001-, 0002-…):
/// patches of commits become commits (`git am`), plain diffs go into the working copy. `None` when
/// the dialog is cancelled.
#[tauri::command]
pub async fn apply_patches(state: State<'_, AppState>, path: String) -> CommandResult<Option<PatchImport>> {
    let root = PathBuf::from(&path);
    let fr = state.language() == "fr";
    let files = rfd::FileDialog::new()
        .set_title(if fr { "Appliquer des patchs" } else { "Apply patches" })
        .add_filter("Patch", &["patch", "diff", "mbox", "eml"])
        .add_filter(if fr { "Tous les fichiers" } else { "All files" }, &["*"])
        .pick_files();
    let Some(mut files) = files else { return Ok(None) };
    files.sort();
    let applied = core::apply_patches(&state.git, &root, &files);
    // Applied or stopped half way, the repository may have changed: it is read again either way.
    let snapshot = changed(&state, root);
    Ok(Some(PatchImport { applied: applied?, snapshot }))
}

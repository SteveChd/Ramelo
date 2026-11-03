//! Pull requests of a repository, on the service its remote points to: the account is the one set
//! up for that server. Their changes are read with git, from commits fetched from the remote. What is
//! read of an open pull request is kept on disk (see `PullCache`), and given back by the `cached_`
//! commands.

use std::path::{Path, PathBuf};

use ramelo_core::{FileDiff, RangeChanges};
use ramelo_hosting::{MergeMethod, NewPull, PullComment, PullDetails, PullRequest, PullState};
use ramelo_storage::{Account, Cached, CachedPull, Provider};
use serde::Serialize;
use tauri::State;

use crate::error::{CommandError, CommandResult};
use crate::state::AppState;

/// Where a repository is hosted: the account, the repository's name on the service and the remote.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hosting {
    pub account_id: String,
    pub provider: Provider,
    /// The repository's name in the API of the service.
    pub key: String,
    pub web_url: String,
    pub remote: String,
    #[serde(skip)]
    account: Account,
}

/// The first remote (« origin » before the others) on a server an account is set up for.
fn hosting(state: &AppState, root: &Path) -> CommandResult<Option<Hosting>> {
    let mut remotes = ramelo_core::remote_urls(&state.git, root)?;
    remotes.sort_by_key(|(name, _)| name != "origin");
    let accounts = state.accounts();
    for (remote, url) in remotes {
        let Some(location) = ramelo_hosting::parse_remote(&url) else { continue };
        let Some(account) = accounts.for_host(&location.hostname).next() else { continue };
        let key = ramelo_hosting::repo_key(account, &location.path);
        return Ok(Some(Hosting {
            account_id: account.id.clone(),
            provider: account.provider,
            web_url: ramelo_hosting::repo_web_url(account, &key),
            key,
            remote,
            account: account.clone(),
        }));
    }
    Ok(None)
}

fn required(state: &AppState, root: &Path) -> CommandResult<Hosting> {
    hosting(state, root)?.ok_or_else(|| CommandError::new("no_hosting", Some(root.display().to_string()), "no account is set up for the remotes of this repository"))
}

/// Where the repository at `path` is hosted, when an account is set up for its server.
#[tauri::command]
pub fn repository_hosting(state: State<'_, AppState>, path: String) -> CommandResult<Option<Hosting>> {
    hosting(&state, Path::new(&path))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullList {
    pub hosting: Hosting,
    pub pulls: Vec<PullRequest>,
}

/// The pull requests of a repository (`open_only`: the open ones); `None` when no account is set up
/// for its remotes.
#[tauri::command]
pub async fn pull_requests(state: State<'_, AppState>, path: String, open_only: bool) -> CommandResult<Option<PullList>> {
    let Some(hosting) = hosting(&state, Path::new(&path))? else { return Ok(None) };
    let pulls = ramelo_hosting::list_pulls(&hosting.account, &hosting.key, open_only)?;
    // Those no longer open (merged, closed) leave the cache.
    let open: Vec<u64> = pulls.iter().filter(|p| p.state == PullState::Open).map(|p| p.number).collect();
    let _ = state.pull_cache.keep_only(Path::new(&path), &open);
    Ok(Some(PullList { hosting, pulls }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullView {
    pub details: PullDetails,
    pub comments: Vec<PullComment>,
}

/// One pull request, with its description and comments.
#[tauri::command]
pub async fn pull_request(state: State<'_, AppState>, path: String, number: u64) -> CommandResult<PullView> {
    let hosting = required(&state, Path::new(&path))?;
    let details = ramelo_hosting::pull_details(&hosting.account, &hosting.key, number)?;
    let comments = ramelo_hosting::pull_comments(&hosting.account, &hosting.key, number)?;
    let view = PullView { details, comments };
    // The cache is a help: failing to write it does not fail the reading.
    let pull = &view.details.pull;
    let _ = if pull.state == PullState::Open {
        state.pull_cache.put_view(Path::new(&path), number, &view, pull.updated, pull.head_oid.clone())
    } else {
        state.pull_cache.forget(Path::new(&path), number)
    };
    Ok(view)
}

/// The commits of a pull request and their changes: its commits and its target branch are fetched
/// first, without changing any branch of the repository.
#[tauri::command]
pub async fn pull_request_changes(state: State<'_, AppState>, path: String, number: u64) -> CommandResult<RangeChanges> {
    let root = PathBuf::from(&path);
    let hosting = required(&state, &root)?;
    // The branches come from the conversation kept when there is one: one request less to the service.
    let pull = match cached_pull(&state, &root, number) {
        Some(pull) => pull,
        None => ramelo_hosting::pull_details(&hosting.account, &hosting.key, number)?.pull,
    };
    let named = |e| crate::commands::ssh::name_host(&state, e, &root);
    let target = ramelo_core::fetch_commit(&state.git, &root, &hosting.remote, &format!("refs/heads/{}", pull.target_branch)).map_err(named)?;
    let (source, reference) = ramelo_hosting::fetch_source(hosting.provider, &pull);
    let head = ramelo_core::fetch_commit(&state.git, &root, source.as_deref().unwrap_or(&hosting.remote), &reference).map_err(named)?;
    let changes = ramelo_core::range_changes(&state.git, &root, &target, &head)?;
    let _ = state.pull_cache.put_changes(&root, number, &changes, &changes.head);
    Ok(changes)
}

/// The pull request as its conversation kept on disk shows it. The list read again tells the
/// interface when it changed, and the conversation is then read again before the changes.
fn cached_pull(state: &AppState, root: &Path, number: u64) -> Option<PullRequest> {
    let kept = state.pull_cache.view(root, number)?;
    serde_json::from_value(kept.data.get("details")?.clone()).ok()
}

/// What is kept on disk of the pull requests of a repository: when each was read, and what it was.
#[tauri::command]
pub fn pull_cache_index(state: State<'_, AppState>, path: String) -> Vec<CachedPull> {
    state.pull_cache.index(Path::new(&path))
}

/// The conversation of a pull request as last read, if kept.
#[tauri::command]
pub async fn cached_pull_request(state: State<'_, AppState>, path: String, number: u64) -> CommandResult<Option<Cached>> {
    Ok(state.pull_cache.view(Path::new(&path), number))
}

/// The changes of a pull request as last read, if kept.
#[tauri::command]
pub async fn cached_pull_request_changes(state: State<'_, AppState>, path: String, number: u64) -> CommandResult<Option<Cached>> {
    Ok(state.pull_cache.changes(Path::new(&path), number))
}

/// One file of the changes between two commits, in full.
#[tauri::command]
pub async fn range_file_diff(state: State<'_, AppState>, path: String, from: String, to: String, file: String) -> CommandResult<Option<FileDiff>> {
    Ok(ramelo_core::range_file_diff(&state.git, Path::new(&path), &from, &to, &file)?)
}

/// Comments one line of the changes of a pull request.
#[tauri::command]
pub async fn comment_pull_request_line(state: State<'_, AppState>, path: String, number: u64, comment: ramelo_hosting::LineComment) -> CommandResult<PullView> {
    let hosting = required(&state, Path::new(&path))?;
    if comment.body.trim().is_empty() {
        return Err(CommandError::new("comment_empty", None, "the comment is empty"));
    }
    ramelo_hosting::add_line_comment(&hosting.account, &hosting.key, number, &comment)?;
    pull_request(state, path, number).await
}

#[tauri::command]
pub async fn comment_pull_request(state: State<'_, AppState>, path: String, number: u64, body: String) -> CommandResult<PullView> {
    let hosting = required(&state, Path::new(&path))?;
    if body.trim().is_empty() {
        return Err(CommandError::new("comment_empty", None, "the comment is empty"));
    }
    ramelo_hosting::add_comment(&hosting.account, &hosting.key, number, &body)?;
    pull_request(state, path, number).await
}

#[tauri::command]
pub async fn merge_pull_request(state: State<'_, AppState>, path: String, number: u64, method: MergeMethod, message: Option<String>) -> CommandResult<PullView> {
    let hosting = required(&state, Path::new(&path))?;
    let message = message.filter(|m| !m.trim().is_empty());
    ramelo_hosting::merge_pull(&hosting.account, &hosting.key, number, method, message.as_deref())?;
    pull_request(state, path, number).await
}

#[tauri::command]
pub async fn close_pull_request(state: State<'_, AppState>, path: String, number: u64) -> CommandResult<PullView> {
    let hosting = required(&state, Path::new(&path))?;
    ramelo_hosting::close_pull(&hosting.account, &hosting.key, number)?;
    pull_request(state, path, number).await
}

/// Opens a pull request from a branch already on the remote.
#[tauri::command]
pub async fn create_pull_request(state: State<'_, AppState>, path: String, pull: NewPull) -> CommandResult<PullRequest> {
    let hosting = required(&state, Path::new(&path))?;
    if pull.title.trim().is_empty() {
        return Err(CommandError::new("title_missing", None, "the title is empty"));
    }
    Ok(ramelo_hosting::create_pull(&hosting.account, &hosting.key, &pull)?)
}

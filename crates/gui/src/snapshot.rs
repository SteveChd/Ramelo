//! What the interface receives after each command: the repositories of the workspace, in tab order,
//! with the last known state of each one. The interface displays these values without computing
//! anything itself.

use std::collections::HashMap;
use std::path::PathBuf;

use gitcontroller_core::{CommitInfo, FileChange, Head, Operation, RepoSummary};
use gitcontroller_storage::Workspace;
use serde::Serialize;

use crate::error::CommandError;
use crate::state::RepoState;

/// Beyond this, the file list is cut (a repository full of build output can have tens of thousands of
/// untracked files); the counts stay exact.
const MAX_FILES: usize = 2000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub repositories: Vec<RepoView>,
    /// Path of the repository shown; `None` for the overview.
    pub active: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoView {
    pub path: String,
    pub name: String,
    /// Colour chosen by the user; `None`: the interface derives one from the name.
    pub color: Option<String>,
    /// The tab is closed: the repository is only shown in the overview.
    pub closed: bool,
    /// `None` until the repository was read, or when it could not be.
    pub summary: Option<SummaryView>,
    pub error: Option<CommandError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryView {
    pub head: Head,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub stashes: u32,
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub conflicted: usize,
    pub operation: Option<Operation>,
    pub remotes: Vec<String>,
    pub last_commit: Option<CommitInfo>,
    pub files: Vec<FileChange>,
    pub file_count: usize,
}

impl From<&RepoSummary> for SummaryView {
    fn from(summary: &RepoSummary) -> Self {
        let status = &summary.status;
        Self {
            head: status.head.clone(),
            upstream: status.upstream.clone(),
            ahead: status.ahead,
            behind: status.behind,
            stashes: status.stashes,
            staged: status.staged(),
            unstaged: status.unstaged(),
            untracked: status.untracked(),
            conflicted: status.conflicted(),
            operation: summary.operation,
            remotes: summary.remotes.clone(),
            last_commit: summary.last_commit.clone(),
            files: status.files.iter().take(MAX_FILES).cloned().collect(),
            file_count: status.files.len(),
        }
    }
}

impl Snapshot {
    pub fn new(workspace: &Workspace, states: &HashMap<PathBuf, RepoState>) -> Self {
        let repositories = workspace
            .repositories
            .iter()
            .map(|entry| {
                let state = states.get(&entry.path);
                RepoView {
                    path: entry.path.display().to_string(),
                    name: entry.path.file_name().map_or_else(|| entry.path.display().to_string(), |n| n.to_string_lossy().into_owned()),
                    color: entry.color.clone(),
                    closed: entry.closed,
                    summary: state.and_then(|s| s.as_ref().ok()).map(SummaryView::from),
                    error: state.and_then(|s| s.as_ref().err()).cloned(),
                }
            })
            .collect();
        Self { repositories, active: workspace.active.as_ref().map(|p| p.display().to_string()) }
    }
}

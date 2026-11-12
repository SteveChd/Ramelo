//! A repository as the application sees it: where it is, and a summary of its state.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::status::{parse_status, STATUS_ARGS};
use crate::{Git, GitError, RepoStatus};

/// Where a repository lives on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoLocation {
    /// Top-level folder of the working tree.
    pub root: PathBuf,
    /// The `.git` folder (elsewhere for a linked worktree or a submodule).
    pub git_dir: PathBuf,
}

impl RepoLocation {
    /// Name shown in the interface: the name of the root folder.
    pub fn name(&self) -> String {
        self.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| self.root.display().to_string())
    }
}

/// Operation left in progress in the repository, which must be continued or aborted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    /// Patches being applied with `git am`.
    Am,
    Rebase,
    Merge,
    CherryPick,
    Revert,
    Bisect,
}

impl Operation {
    /// Detected from the marker files git leaves in its folder.
    pub fn detect(git_dir: &Path) -> Option<Self> {
        let has = |name: &str| git_dir.join(name).exists();
        // `git am` works in « rebase-apply » too, and leaves « applying » there.
        if has("rebase-apply/applying") {
            Some(Self::Am)
        } else if has("rebase-merge") || has("rebase-apply") {
            Some(Self::Rebase)
        } else if has("MERGE_HEAD") {
            Some(Self::Merge)
        } else if has("CHERRY_PICK_HEAD") {
            Some(Self::CherryPick)
        } else if has("REVERT_HEAD") {
            Some(Self::Revert)
        } else if has("BISECT_LOG") {
            Some(Self::Bisect)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub oid: String,
    pub summary: String,
    pub author: String,
    /// Commit time, in seconds since the Unix epoch.
    pub time: i64,
}

/// Everything the multi-repository overview shows about one repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub status: RepoStatus,
    pub operation: Option<Operation>,
    pub remotes: Vec<String>,
    /// Last commit of HEAD; `None` before the first commit.
    pub last_commit: Option<CommitInfo>,
}

/// Finds the repository that contains `path` (any folder inside the working tree works).
pub fn open(git: &Git, path: &Path) -> Result<RepoLocation, GitError> {
    if !path.exists() {
        return Err(GitError::PathMissing(path.to_path_buf()));
    }
    let text = match git.text(path, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]) {
        Ok(text) => text,
        Err(GitError::Failed { message, .. }) if message.contains("not a git repository") || message.contains("must be run in a work tree") => {
            return Err(GitError::NotARepository(path.to_path_buf()));
        }
        Err(error) => return Err(error),
    };
    let mut lines = text.lines();
    let (Some(root), Some(git_dir)) = (lines.next(), lines.next()) else {
        return Err(GitError::Parse { command: "rev-parse".into(), detail: text.clone() });
    };
    Ok(RepoLocation { root: normalize(root), git_dir: normalize(git_dir) })
}

/// Reads the state of the repository whose working tree is `location`.
pub fn summary(git: &Git, location: &RepoLocation) -> Result<RepoSummary, GitError> {
    let root = &location.root;
    let status = parse_status(&git.output(root, STATUS_ARGS)?)?;
    let remotes = git.text(root, ["remote"])?.lines().map(str::to_owned).collect();
    let last_commit = if status.head.is_unborn() { None } else { Some(last_commit(git, root)?) };
    Ok(RepoSummary { status, operation: Operation::detect(&location.git_dir), remotes, last_commit })
}

fn last_commit(git: &Git, root: &Path) -> Result<CommitInfo, GitError> {
    let text = git.text(root, ["log", "-1", "--format=%H%x00%s%x00%an%x00%ct"])?;
    let parts: Vec<&str> = text.trim_end_matches('\n').split('\0').collect();
    let bad = || GitError::Parse { command: "log".into(), detail: text.clone() };
    let [oid, summary, author, time] = parts[..] else { return Err(bad()) };
    Ok(CommitInfo { oid: oid.into(), summary: summary.into(), author: author.into(), time: time.parse().map_err(|_| bad())? })
}

/// Git prints « C:/Users/… » on Windows: the path is turned into the native form, so that the same
/// repository is always recorded under the same path.
pub(crate) fn normalize(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    dunce::canonicalize(&path).unwrap_or(path)
}

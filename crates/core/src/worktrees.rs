//! The worktrees of a repository: the main folder and the linked ones (`git worktree`), each with a
//! branch of its own checked out. Listed, created and removed here; switching from one to another is
//! the interface's business (the tab follows the folder).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::repo::normalize;
use crate::{Git, GitError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// Top-level folder, in the same form as the paths of the workspace.
    pub path: PathBuf,
    /// Commit checked out; `None` before the first commit.
    pub head: Option<String>,
    /// Branch checked out (short name); `None` when HEAD is detached.
    pub branch: Option<String>,
    /// The main working tree, the one that holds the `.git` folder: it cannot be removed.
    pub main: bool,
    /// The worktree the list was read from.
    pub current: bool,
    /// Locked by `git worktree lock` (a removable disk…): git refuses to remove it.
    pub locked: bool,
    /// Its folder is gone: only git's records of it are left.
    pub missing: bool,
}

/// The worktrees of the repository of `root`, the main one first.
pub fn list(git: &Git, root: &Path) -> Result<Vec<WorktreeInfo>, GitError> {
    let text = git.text(root, ["worktree", "list", "--porcelain"])?;
    let here = normalize(&root.to_string_lossy());
    let mut list = Vec::new();
    // One block per worktree, separated by an empty line; the first one is the main worktree.
    for block in text.split("\n\n").filter(|b| !b.trim().is_empty()) {
        let mut info = WorktreeInfo { path: PathBuf::new(), head: None, branch: None, main: list.is_empty(), current: false, locked: false, missing: false };
        let mut bare = false;
        for line in block.lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => info.path = normalize(value),
                "HEAD" => info.head = Some(value.to_owned()).filter(|oid| !oid.trim_matches('0').is_empty()),
                "branch" => info.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_owned()),
                "bare" => bare = true,
                "locked" => info.locked = true,
                "prunable" => info.missing = true,
                _ => {}
            }
        }
        if bare {
            continue;
        }
        info.missing |= !info.path.exists();
        info.current = info.path == here;
        list.push(info);
    }
    Ok(list)
}

/// What the new worktree checks out.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum WorktreeTarget {
    /// A local branch that no worktree has checked out yet.
    Existing { branch: String },
    /// A new branch, started from `start` (a commit, a branch, a remote branch that it then tracks).
    New { branch: String, start: String },
}

/// Creates a worktree in `folder` (which must not exist or be empty); returns its top-level folder.
pub fn add(git: &Git, root: &Path, folder: &Path, target: &WorktreeTarget) -> Result<PathBuf, GitError> {
    if folder.read_dir().is_ok_and(|mut entries| entries.next().is_some()) {
        return Err(GitError::TargetExists(folder.to_path_buf()));
    }
    let folder_arg = folder.as_os_str().to_owned();
    let mut args: Vec<std::ffi::OsString> = vec!["worktree".into(), "add".into()];
    match target {
        WorktreeTarget::Existing { branch } => {
            args.extend([folder_arg, branch.into()]);
        }
        WorktreeTarget::New { branch, start } => {
            crate::branches::validate_name(git, root, branch)?;
            args.extend(["-b".into(), branch.into(), folder_arg, start.into()]);
        }
    }
    git.output(root, &args)?;
    Ok(normalize(&folder.to_string_lossy()))
}

/// Removes the linked worktree of `folder`: its folder is deleted, the branch stays. Without `force`,
/// a worktree with changes not committed is refused ([`GitError::WorktreeDirty`]).
pub fn remove(git: &Git, root: &Path, folder: &Path, force: bool) -> Result<(), GitError> {
    let target = list(git, root)?.into_iter().find(|w| w.path == normalize(&folder.to_string_lossy()));
    if target.as_ref().is_some_and(|w| w.main) {
        return Err(GitError::Failed { command: "worktree remove".into(), message: "the main working tree cannot be removed".into() });
    }
    if target.as_ref().is_some_and(|w| w.missing) {
        // The folder is already gone: git only forgets it.
        return git.output(root, ["worktree", "prune"]).map(drop);
    }
    let mut args: Vec<std::ffi::OsString> = vec!["worktree".into(), "remove".into()];
    if force {
        // Twice: also when it is locked.
        args.extend(["--force".into(), "--force".into()]);
    }
    args.push(folder.as_os_str().to_owned());
    git.output(root, &args).map(drop)
}

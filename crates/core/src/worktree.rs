//! Changes to the working copy and the index: stage, unstage, discard (whole files or single hunks),
//! and commit.

use std::path::Path;

use crate::status::{parse_status, STATUS_ARGS};
use crate::{Git, GitError};

/// Paths are sent on standard input (NUL-separated) rather than as arguments: a long list would
/// exceed the command-line limit of Windows, and a path is never read as a pattern.
fn with_paths(git: &Git, root: &Path, args: &[&str], paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut full: Vec<&str> = args.to_vec();
    full.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    git.output_with_input(root, &[&["--literal-pathspecs"][..], &full].concat(), &input)?;
    Ok(())
}

/// Stages the files (new, modified and deleted alike).
pub fn stage(git: &Git, root: &Path, paths: &[String]) -> Result<(), GitError> {
    with_paths(git, root, &["add", "--all"], paths)
}

pub fn stage_all(git: &Git, root: &Path) -> Result<(), GitError> {
    git.output(root, ["add", "--all"]).map(drop)
}

/// Takes the files out of the index; their changes stay in the working copy.
pub fn unstage(git: &Git, root: &Path, paths: &[String]) -> Result<(), GitError> {
    if has_head(git, root) {
        with_paths(git, root, &["restore", "--staged"], paths)
    } else {
        // Before the first commit there is nothing to restore from: the files are simply removed
        // from the index.
        with_paths(git, root, &["rm", "--cached", "-r", "-q", "--ignore-unmatch"], paths)
    }
}

pub fn unstage_all(git: &Git, root: &Path) -> Result<(), GitError> {
    if has_head(git, root) {
        git.output(root, ["reset", "-q"]).map(drop)
    } else {
        git.output(root, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "."]).map(drop)
    }
}

/// Throws away the changes that are not staged: tracked files go back to their staged (or committed)
/// content, and untracked files are deleted.
pub fn discard(git: &Git, root: &Path, tracked: &[String], untracked: &[String]) -> Result<(), GitError> {
    with_paths(git, root, &["restore", "--worktree"], tracked)?;
    // `git clean` cannot read paths from standard input; they go in batches.
    for batch in untracked.chunks(100) {
        let mut args = vec!["--literal-pathspecs", "clean", "-f", "-q", "--"];
        args.extend(batch.iter().map(String::as_str));
        git.output(root, &args)?;
    }
    Ok(())
}

/// What to do with a hunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HunkAction {
    /// Add an unstaged hunk to the index.
    Stage,
    /// Take a staged hunk out of the index.
    Unstage,
    /// Throw an unstaged hunk away from the working copy.
    Discard,
}

/// Applies `patch` (one hunk, from [`crate::FileDiff::hunk_patch`]) to the index or the working copy.
pub fn apply_hunk(git: &Git, root: &Path, patch: &str, action: HunkAction) -> Result<(), GitError> {
    let args: &[&str] = match action {
        HunkAction::Stage => &["apply", "--cached", "--whitespace=nowarn", "-"],
        HunkAction::Unstage => &["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"],
        HunkAction::Discard => &["apply", "--reverse", "--whitespace=nowarn", "-"],
    };
    git.output_with_input(root, args, patch.as_bytes()).map(drop)
}

/// Records a commit with `message`. With `amend`, the last commit is replaced instead (its changes and
/// the staged ones together). Returns the new commit.
pub fn commit(git: &Git, root: &Path, message: &str, amend: bool) -> Result<String, GitError> {
    if !amend {
        let status = parse_status(&git.output(root, STATUS_ARGS)?)?;
        if status.staged() == 0 {
            return Err(GitError::NothingToCommit);
        }
    }
    let mut args = vec!["commit", "--quiet", "--file=-"];
    if amend {
        args.push("--amend");
    }
    git.output_with_input(root, &args, message.as_bytes())?;
    Ok(git.text(root, ["rev-parse", "HEAD"])?.trim().to_owned())
}

/// Full message of the last commit, to start from when amending.
pub fn last_message(git: &Git, root: &Path) -> Result<Option<String>, GitError> {
    if !has_head(git, root) {
        return Ok(None);
    }
    Ok(Some(git.text(root, ["log", "-1", "--format=%B"])?.trim_end().to_owned()))
}

fn has_head(git: &Git, root: &Path) -> bool {
    git.raw(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok_and(|o| o.status.success())
}

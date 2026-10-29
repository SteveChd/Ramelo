//! Changes between two commits, as a pull request shows them: the commits of the source branch since
//! it left the target one, and what they change together. The commits are first fetched from the
//! remote under the reference the service publishes for the pull request.

use std::path::Path;

use serde::Serialize;

use crate::diff::{parse_diff, FileDiff, MAX_LINES_PER_COMMIT, MAX_LINES_PER_FILE};
use crate::{Git, GitError};

/// The remotes of a repository with their address (the fetch one).
pub fn remote_urls(git: &Git, root: &Path) -> Result<Vec<(String, String)>, GitError> {
    let out = git.raw(root, &["config", "--get-regexp", r"^remote\..*\.url$"])?;
    // Status 1: no remote at all.
    if out.status.code() == Some(1) {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&Git::check(&["config", "--get-regexp"], out)?).into_owned();
    Ok(text
        .lines()
        .filter_map(|line| {
            let (key, url) = line.split_once(' ')?;
            let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
            Some((name.to_owned(), url.trim().to_owned()))
        })
        .collect())
}

/// Fetches `reference` from `source` (a remote, or an address) without keeping it under a name;
/// returns the commit it points to.
pub fn fetch_commit(git: &Git, root: &Path, source: &str, reference: &str) -> Result<String, GitError> {
    git.output(root, ["fetch", "--no-tags", "--no-write-fetch-head", source, &format!("+{reference}:refs/ramelo/fetched")])?;
    let oid = git.text(root, ["rev-parse", "--verify", "refs/ramelo/fetched^{commit}"])?.trim().to_owned();
    // The commit stays in the object store; the temporary name goes.
    git.output(root, ["update-ref", "-d", "refs/ramelo/fetched"])?;
    Ok(oid)
}

/// A commit of a range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeCommit {
    pub oid: String,
    pub summary: String,
    pub author: String,
    pub time: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeChanges {
    /// Where the source branch left the target one: the changes are counted from there.
    pub base: String,
    pub head: String,
    /// Newest first.
    pub commits: Vec<RangeCommit>,
    pub files: Vec<FileDiff>,
}

/// What `head` brings to `target`: its commits since they diverged, and their changes together (as
/// « git diff target...head »).
pub fn range_changes(git: &Git, root: &Path, target: &str, head: &str) -> Result<RangeChanges, GitError> {
    let base = git.text(root, ["merge-base", target, head])?.trim().to_owned();
    let log = git.text(root, ["log", "--no-color", "--format=%H%x1f%an%x1f%at%x1f%s", &format!("{base}..{head}")])?;
    let commits = log
        .lines()
        .filter_map(|line| {
            let mut f = line.splitn(4, '\x1f');
            Some(RangeCommit { oid: f.next()?.to_owned(), author: f.next()?.to_owned(), time: f.next()?.parse().ok()?, summary: f.next().unwrap_or("").to_owned() })
        })
        .collect();
    let patch = git.output(root, ["diff", "--no-ext-diff", "--no-color", "-M", &base, head])?;
    Ok(RangeChanges { files: parse_diff(&String::from_utf8_lossy(&patch), MAX_LINES_PER_COMMIT), base, head: head.to_owned(), commits })
}

/// One file of a range, in full (when the diff of the whole range had to be cut).
pub fn range_file_diff(git: &Git, root: &Path, from: &str, to: &str, path: &str) -> Result<Option<FileDiff>, GitError> {
    let patch = git.output(root, ["diff", "--no-ext-diff", "--no-color", "-M", from, to, "--", path])?;
    Ok(parse_diff(&String::from_utf8_lossy(&patch), MAX_LINES_PER_FILE).into_iter().next())
}

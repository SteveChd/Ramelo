//! Branches and tags: listing them, switching, creating and deleting branches.
//!
//! Switching is made forgiving: a remote branch becomes a local branch that tracks it, and local
//! changes can be carried over to the other branch (stashed, then re-applied).

use std::path::Path;

use serde::Serialize;

use crate::status::{parse_status, STATUS_ARGS};
use crate::{Git, GitError, Operation};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// « main », or « origin/main » for a remote branch.
    pub name: String,
    pub oid: String,
    /// Remote branch tracked by a local branch.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The tracked remote branch was deleted on the remote.
    pub gone: bool,
    pub is_head: bool,
    /// Time of the last commit.
    pub time: i64,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub name: String,
    /// The tagged commit (annotated tags are followed to it).
    pub oid: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefList {
    pub local: Vec<Branch>,
    pub remote: Vec<Branch>,
    pub tags: Vec<Tag>,
}

const FORMAT: &str = "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(committerdate:unix)%1f%(contents:subject)";

pub fn list(git: &Git, root: &Path) -> Result<RefList, GitError> {
    let text = git.text(root, ["for-each-ref", "--sort=-committerdate", FORMAT, "refs/heads", "refs/remotes", "refs/tags"])?;
    let mut refs = RefList::default();
    for line in text.lines().filter(|l| !l.is_empty()) {
        let fields: Vec<&str> = line.splitn(8, '\x1f').collect();
        let [name, oid, peeled, upstream, track, head, time, summary] = fields[..] else {
            return Err(GitError::Parse { command: "for-each-ref".into(), detail: line.to_owned() });
        };
        let (ahead, behind, gone) = parse_track(track);
        let branch = |short: &str| Branch {
            name: short.to_owned(),
            oid: oid.to_owned(),
            upstream: (!upstream.is_empty()).then(|| upstream.to_owned()),
            ahead,
            behind,
            gone,
            is_head: head == "*",
            time: time.parse().unwrap_or(0),
            summary: summary.to_owned(),
        };
        if let Some(short) = name.strip_prefix("refs/heads/") {
            refs.local.push(branch(short));
        } else if let Some(short) = name.strip_prefix("refs/remotes/") {
            if !short.ends_with("/HEAD") {
                refs.remote.push(branch(short));
            }
        } else if let Some(short) = name.strip_prefix("refs/tags/") {
            let oid = if peeled.is_empty() { oid } else { peeled };
            refs.tags.push(Tag { name: short.to_owned(), oid: oid.to_owned() });
        }
    }
    Ok(refs)
}

/// « ahead 2, behind 1 », « gone » or nothing.
fn parse_track(track: &str) -> (u32, u32, bool) {
    let mut counts = (0, 0, track == "gone");
    for part in track.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            counts.0 = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            counts.1 = n.parse().unwrap_or(0);
        }
    }
    counts
}

pub fn validate_name(git: &Git, root: &Path, name: &str) -> Result<(), GitError> {
    let out = git.raw(root, &["check-ref-format", "--branch", name])?;
    if out.status.success() && !name.is_empty() {
        Ok(())
    } else {
        Err(GitError::InvalidBranchName(name.to_owned()))
    }
}

/// What happened to the local changes carried over to the other branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Carried {
    /// There was nothing to carry.
    Nothing,
    /// The changes are back in the working copy.
    Reapplied,
    /// Re-applying them conflicted: they are in the working copy with conflict markers, and kept in
    /// the stash as well.
    Conflicted,
}

/// Switches to `target`: a local branch, a remote branch (« origin/x », which becomes a local
/// branch « x » tracking it, or the existing local « x »), or a commit (detached HEAD).
/// With `carry_changes`, local changes are stashed first and re-applied on the other side.
pub fn switch(git: &Git, root: &Path, target: &str, carry_changes: bool) -> Result<Carried, GitError> {
    let refs = list(git, root)?;
    let args: Vec<String> = if refs.local.iter().any(|b| b.name == target) {
        vec!["switch".into(), target.into()]
    } else if let Some(remote) = refs.remote.iter().find(|b| b.name == target) {
        let local = remote.name.split_once('/').map_or(remote.name.as_str(), |(_, rest)| rest);
        if refs.local.iter().any(|b| b.name == local) {
            vec!["switch".into(), local.into()]
        } else {
            vec!["switch".into(), "--track".into(), target.into()]
        }
    } else {
        vec!["switch".into(), "--detach".into(), target.into()]
    };

    let dirty = carry_changes && !parse_status(&git.output(root, STATUS_ARGS)?)?.is_clean();
    if !dirty {
        git.output(root, &args)?;
        return Ok(Carried::Nothing);
    }
    let message = format!("GitController: changes carried over to {target}");
    git.output(root, ["stash", "push", "--include-untracked", "--message", &message])?;
    if let Err(error) = git.output(root, &args) {
        // Back to where we were, with the changes.
        let _ = git.output(root, ["stash", "pop", "--index"]);
        return Err(error);
    }
    match git.output(root, ["stash", "pop"]) {
        Ok(_) => Ok(Carried::Reapplied),
        Err(_) if has_conflicts(git, root)? => Ok(Carried::Conflicted),
        Err(error) => Err(error),
    }
}

fn has_conflicts(git: &Git, root: &Path) -> Result<bool, GitError> {
    Ok(parse_status(&git.output(root, STATUS_ARGS)?)?.conflicted() > 0)
}

/// Creates branch `name` at `start` (HEAD when `None`), and switches to it with `checkout`.
pub fn create(git: &Git, root: &Path, name: &str, start: Option<&str>, checkout: bool) -> Result<(), GitError> {
    validate_name(git, root, name)?;
    let mut args = if checkout { vec!["switch", "--create", name] } else { vec!["branch", name] };
    args.extend(start);
    git.output(root, &args).map(drop)
}

/// Deletes a local branch; without `force`, git refuses when its commits are not merged anywhere.
pub fn delete(git: &Git, root: &Path, name: &str, force: bool) -> Result<(), GitError> {
    git.output(root, ["branch", if force { "-D" } else { "-d" }, name]).map(drop)
}

/// Operation in progress, for callers that must tell a conflict from another failure.
pub(crate) fn operation(git: &Git, root: &Path) -> Result<Option<Operation>, GitError> {
    let git_dir = git.text(root, ["rev-parse", "--absolute-git-dir"])?;
    Ok(Operation::detect(Path::new(git_dir.trim())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_tracking_state() {
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("ahead 2"), (2, 0, false));
        assert_eq!(parse_track("ahead 2, behind 13"), (2, 13, false));
        assert_eq!(parse_track("gone"), (0, 0, true));
    }
}

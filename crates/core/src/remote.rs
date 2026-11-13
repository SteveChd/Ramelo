//! Exchanges with remotes: fetch, pull and push, with the usual stumbling blocks handled for the
//! user (a first push sets the upstream, a pull fast-forwards when it can and asks otherwise).

use std::path::Path;

use serde::Serialize;

use crate::branches::operation;
use crate::status::{parse_status, STATUS_ARGS};
use crate::{Git, GitError};

/// Fetches every remote and forgets the remote branches deleted there.
pub fn fetch(git: &Git, root: &Path) -> Result<(), GitError> {
    if remotes(git, root)?.is_empty() {
        return Err(GitError::NoRemote);
    }
    git.output(root, ["fetch", "--all", "--prune"]).map(drop)
}

/// Same as [`fetch`], started by the application rather than by the user: nothing may ask anything
/// (no window of a credential manager, no passphrase of an ssh key), and a connection that stalls
/// gives up instead of holding the next repositories back. Returns whether a remote branch or a tag
/// moved, appeared or went away.
pub fn fetch_in_background(git: &Git, root: &Path) -> Result<bool, GitError> {
    if remotes(git, root)?.is_empty() {
        return Err(GitError::NoRemote);
    }
    let args = [
        "-c", "credential.interactive=false",
        "-c", "http.lowSpeedLimit=1000",
        "-c", "http.lowSpeedTime=60",
        "fetch", "--all", "--prune", "--quiet",
    ];
    let never = std::ffi::OsStr::new("never");
    let env = [("GCM_INTERACTIVE", never), ("SSH_ASKPASS_REQUIRE", never)];
    let refs = || git.output(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes", "refs/tags"]);
    let before = refs()?;
    git.output_with_env(root, &args, &env)?;
    Ok(refs()? != before)
}

fn remotes(git: &Git, root: &Path) -> Result<Vec<String>, GitError> {
    Ok(git.text(root, ["remote"])?.lines().map(str::to_owned).collect())
}

/// How to bring in remote commits when the branch also has commits of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    /// Fast-forward only; a diverged branch is reported so that the user can choose.
    Auto,
    /// Replay the local commits on top of the remote ones.
    Rebase,
    /// Join both lines of history with a merge commit.
    Merge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PullOutcome {
    UpToDate,
    FastForwarded { commits: u32 },
    Rebased { commits: u32 },
    Merged { commits: u32 },
}

/// Fetches the upstream of the current branch and brings its commits in. Local changes are stashed
/// and re-applied around the operation.
pub fn pull(git: &Git, root: &Path, mode: PullMode) -> Result<PullOutcome, GitError> {
    let status = parse_status(&git.output(root, STATUS_ARGS)?)?;
    let branch = status.head.branch.clone().ok_or(GitError::DetachedHead)?;
    if status.upstream.is_none() {
        return Err(GitError::NoUpstream(branch));
    }
    git.output(root, ["fetch", "--prune"])?;
    let status = parse_status(&git.output(root, STATUS_ARGS)?)?;
    let behind = status.behind;
    if behind == 0 {
        return Ok(PullOutcome::UpToDate);
    }
    let (args, outcome): (&[&str], PullOutcome) = match (status.ahead, mode) {
        (0, _) => (&["merge", "--ff-only", "--autostash", "@{upstream}"], PullOutcome::FastForwarded { commits: behind }),
        (_, PullMode::Auto) => return Err(GitError::Diverged),
        (_, PullMode::Rebase) => (&["rebase", "--autostash", "@{upstream}"], PullOutcome::Rebased { commits: behind }),
        (_, PullMode::Merge) => (&["merge", "--autostash", "--no-edit", "@{upstream}"], PullOutcome::Merged { commits: behind }),
    };
    match git.output(root, args) {
        Ok(_) => Ok(outcome),
        Err(_) if operation(git, root)?.is_some() => Err(GitError::Conflicts),
        Err(error) => Err(error),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub remote: String,
    pub branch: String,
    /// The branch had no upstream: it now tracks the branch just created on the remote.
    pub upstream_set: bool,
}

/// Pushes the current branch to the branch it tracks. A branch that tracks nothing yet is pushed
/// to « origin » (or the only remote) under the same name, and set to track it. `force` replaces the
/// remote branch, but only if nobody pushed to it since the last fetch (`--force-with-lease`).
/// `upto`: push only the commits of the branch up to this one (included), the later ones staying
/// local; it must be in the history of the branch.
pub fn push(git: &Git, root: &Path, force: bool, upto: Option<&str>) -> Result<PushOutcome, GitError> {
    let status = parse_status(&git.output(root, STATUS_ARGS)?)?;
    let branch = status.head.branch.clone().ok_or(GitError::DetachedHead)?;
    let source = match upto {
        Some(commit) => {
            let oid = git.text(root, ["rev-parse", "--verify", "--quiet", &format!("{commit}^{{commit}}")])
                .map(|o| o.trim().to_owned())
                .map_err(|_| GitError::NotInHistory(commit.to_owned()))?;
            if git.output(root, ["merge-base", "--is-ancestor", &oid, "HEAD"]).is_err() {
                return Err(GitError::NotInHistory(commit.to_owned()));
            }
            oid
        }
        None => "HEAD".to_owned(),
    };
    let config = |key: &str| {
        git.text(root, ["config", "--get", &format!("branch.{branch}.{key}")]).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
    };
    let (remote, target, upstream_set) = match (config("remote"), config("merge")) {
        (Some(remote), Some(merge)) if status.upstream.is_some() => (remote, merge, false),
        _ => {
            let remotes = remotes(git, root)?;
            let remote = remotes.iter().find(|r| *r == "origin").or(remotes.first()).cloned().ok_or(GitError::NoRemote)?;
            (remote, format!("refs/heads/{branch}"), true)
        }
    };
    let refspec = format!("{source}:{target}");
    let mut args = vec!["push", "--porcelain"];
    if force {
        args.push("--force-with-lease");
    }
    // git sets the upstream only when it pushes a branch, not a commit: that case is done below.
    if upstream_set && upto.is_none() {
        args.push("--set-upstream");
    }
    args.extend([remote.as_str(), refspec.as_str()]);
    git.output(root, &args)?;
    if upstream_set && upto.is_some() {
        git.output(root, ["config", &format!("branch.{branch}.remote"), &remote])?;
        git.output(root, ["config", &format!("branch.{branch}.merge"), &target])?;
    }
    Ok(PushOutcome { remote, branch: target.trim_start_matches("refs/heads/").to_owned(), upstream_set })
}

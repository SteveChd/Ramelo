//! Errors of the git layer.
//!
//! Each error has a stable code ([`GitError::code`]) that the interface translates into the chosen
//! language; the English `Display` text is used for logs and tests.

use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("git is not installed or cannot be found in the PATH")]
    GitNotFound,
    #[error("« {0} » does not exist")]
    PathMissing(PathBuf),
    #[error("« {0} » is not inside a git repository")]
    NotARepository(PathBuf),
    #[error("no git repository was found in « {0} »")]
    NoRepositoryFound(PathBuf),
    #[error("`git {command}` failed: {message}")]
    Failed { command: String, message: String },
    #[error("unexpected output from `git {command}`: {detail}")]
    Parse { command: String, detail: String },
    #[error("cannot run git in « {path} »: {source}")]
    Io { path: PathBuf, source: std::io::Error },
    #[error("git does not know who you are: set user.name and user.email")]
    IdentityMissing,
    #[error("local changes would be overwritten: {0}")]
    LocalChanges(String),
    #[error("the branch and its upstream have diverged")]
    Diverged,
    #[error("the remote has commits that are not here yet: {0}")]
    PushRejected(String),
    #[error("the remote refused the credentials: {0}")]
    AuthFailed(String),
    /// ssh does not know the server yet, and cannot ask whether to trust it. The server, when ssh
    /// names it (empty otherwise: the caller knows the address).
    #[error("ssh does not know the server {0} yet")]
    HostUnknown(String),
    #[error("branch « {0} » is not merged")]
    BranchNotMerged(String),
    #[error("« {0} » is not a valid branch name")]
    InvalidBranchName(String),
    #[error("nothing is staged for the commit")]
    NothingToCommit,
    #[error("the repository has no remote")]
    NoRemote,
    #[error("branch « {0} » does not track any remote branch")]
    NoUpstream(String),
    #[error("HEAD is not on a branch")]
    DetachedHead,
    #[error("the operation stopped on conflicts")]
    Conflicts,
    #[error("« {0} » is not a valid regular expression")]
    InvalidPattern(String),
    #[error("a rebase, merge or other operation is in progress")]
    OperationInProgress,
    #[error("commit {0} is not in the history of HEAD")]
    NotInHistory(String),
    #[error("a later commit also changed « {0} » in a way that conflicts")]
    RewriteConflict(String),
    #[error("commit {0} cannot be combined with the one before it")]
    CannotSquash(String),
    #[error("commit {0} cannot be moved: the commits around it must follow one another, without a merge")]
    CannotMove(String),
    #[error("moving the commit conflicts on « {0} »: the two commits change the same place")]
    MoveConflict(String),
    #[error("the branch is already checked out in the worktree « {0} »")]
    BranchInWorktree(String),
    #[error("{0} files still have conflicts")]
    ConflictsRemain(usize),
    #[error("no merge, rebase or other operation is in progress")]
    NoOperation,
    #[error("after the resolution, the commit no longer changes anything")]
    EmptyAfterResolution,
    #[error("« {0} » is not a repository address")]
    InvalidUrl(String),
    #[error("the folder « {0} » already exists and is not empty")]
    TargetExists(PathBuf),
    #[error("stopped")]
    Cancelled,
}

impl GitError {
    /// Stable snake_case code, used by the interface to show the translated message.
    pub fn code(&self) -> &'static str {
        match self {
            Self::GitNotFound => "git_not_found",
            Self::PathMissing(_) => "path_missing",
            Self::NotARepository(_) => "not_a_repository",
            Self::NoRepositoryFound(_) => "no_repository_found",
            Self::Failed { .. } => "git_failed",
            Self::Parse { .. } => "git_output",
            Self::Io { .. } => "git_io",
            Self::IdentityMissing => "identity_missing",
            Self::LocalChanges(_) => "local_changes",
            Self::Diverged => "diverged",
            Self::InvalidPattern(_) => "invalid_pattern",
            Self::PushRejected(_) => "push_rejected",
            Self::AuthFailed(_) => "auth_failed",
            Self::HostUnknown(_) => "host_unknown",
            Self::BranchNotMerged(_) => "branch_not_merged",
            Self::InvalidBranchName(_) => "invalid_branch_name",
            Self::NothingToCommit => "nothing_to_commit",
            Self::NoRemote => "no_remote",
            Self::NoUpstream(_) => "no_upstream",
            Self::DetachedHead => "detached_head",
            Self::Conflicts => "conflicts",
            Self::OperationInProgress => "operation_in_progress",
            Self::NotInHistory(_) => "not_in_history",
            Self::RewriteConflict(_) => "rewrite_conflict",
            Self::CannotSquash(_) => "cannot_squash",
            Self::CannotMove(_) => "cannot_move",
            Self::MoveConflict(_) => "move_conflict",
            Self::BranchInWorktree(_) => "branch_in_worktree",
            Self::ConflictsRemain(_) => "conflicts_remain",
            Self::NoOperation => "no_operation",
            Self::EmptyAfterResolution => "empty_after_resolution",
            Self::InvalidUrl(_) => "invalid_url",
            Self::TargetExists(_) => "target_exists",
            Self::Cancelled => "cancelled",
        }
    }

    /// What the error is about (a folder, a command), to insert in the translated message.
    pub fn subject(&self) -> Option<String> {
        match self {
            Self::GitNotFound | Self::IdentityMissing | Self::Diverged | Self::NothingToCommit | Self::NoRemote | Self::Conflicts | Self::OperationInProgress => None,
            Self::LocalChanges(detail) | Self::PushRejected(detail) | Self::AuthFailed(detail) | Self::HostUnknown(detail) => Some(detail.clone()),
            Self::BranchNotMerged(name) | Self::InvalidBranchName(name) | Self::NoUpstream(name) | Self::InvalidPattern(name) => Some(name.clone()),
            Self::NotInHistory(name) | Self::RewriteConflict(name) | Self::CannotSquash(name) | Self::BranchInWorktree(name) => Some(name.clone()),
            Self::CannotMove(name) | Self::MoveConflict(name) => Some(name.clone()),
            Self::DetachedHead | Self::NoOperation | Self::EmptyAfterResolution | Self::Cancelled => None,
            Self::InvalidUrl(url) => Some(url.clone()),
            Self::TargetExists(path) => Some(path.display().to_string()),
            Self::ConflictsRemain(count) => Some(count.to_string()),
            Self::PathMissing(path) | Self::NotARepository(path) | Self::NoRepositoryFound(path) => {
                Some(path.display().to_string())
            }
            Self::Io { path, .. } => Some(path.display().to_string()),
            Self::Failed { command, .. } | Self::Parse { command, .. } => Some(command.clone()),
        }
    }
}

/// What git or ssh says when the remote refuses the user.
const AUTH_FAILURES: &[&str] = &["Authentication failed", "could not read Username", "Permission denied (publickey", "terminal prompts disabled", "Host key verification failed"];

/// Turns git's message for a failed command into a precise error when it is a well-known situation
/// that the interface can explain or offer to fix.
pub(crate) fn classify(command: String, message: String, output: &str) -> GitError {
    let any = |needles: &[&str]| needles.iter().any(|n| output.contains(n));
    if any(&["Please tell me who you are", "Author identity unknown", "unable to auto-detect email address"]) {
        GitError::IdentityMissing
    } else if any(&["would be overwritten by", "Please commit your changes or stash them"]) {
        GitError::LocalChanges(message)
    } else if any(&["Not possible to fast-forward", "Not a fast-forward", "Diverging branches can't be fast-forwarded"]) {
        GitError::Diverged
    } else if any(&["[rejected]", "non-fast-forward", "fetch first"]) {
        GitError::PushRejected(message)
    } else if any(&["Host key verification failed"]) && !any(&["HAS CHANGED", "has changed"]) {
        // « No ED25519 host key is known for host and you have requested strict checking. »
        let host = output.split(" host key is known for ").nth(1).and_then(|r| r.split_whitespace().next()).unwrap_or_default();
        GitError::HostUnknown(host.to_owned())
    } else if any(AUTH_FAILURES) {
        // The line that says why (from ssh, often), rather than git's « Could not read from remote ».
        let cause = output.lines().map(str::trim).find(|l| AUTH_FAILURES.iter().any(|n| l.contains(n)));
        GitError::AuthFailed(cause.map_or(message, |l| l.trim_start_matches("fatal: ").to_owned()))
    } else if let Some(path) = ["is already used by worktree at '", "is already checked out at '"].iter().find_map(|n| output.split(n).nth(1)) {
        GitError::BranchInWorktree(path.split('\'').next().unwrap_or_default().to_owned())
    } else if let Some(name) = output.split("branch '").nth(1).filter(|_| output.contains("is not fully merged")) {
        GitError::BranchNotMerged(name.split('\'').next().unwrap_or_default().to_owned())
    } else {
        GitError::Failed { command, message }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_remote_says_why() {
        let output = "Cloning into 'x'...\ngit@bitbucket.org: Permission denied (publickey).\nfatal: Could not read from remote repository.\n";
        match classify("clone".into(), "Could not read from remote repository.".into(), output) {
            GitError::AuthFailed(detail) => assert_eq!(detail, "git@bitbucket.org: Permission denied (publickey)."),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_unknown_server_is_told_apart_from_a_changed_one() {
        let unknown = "No ED25519 host key is known for ssh.bitbucket.org and you have requested strict checking.\nHost key verification failed.\nfatal: Could not read from remote repository.";
        assert!(matches!(classify("clone".into(), String::new(), unknown), GitError::HostUnknown(h) if h == "ssh.bitbucket.org"));
        assert!(matches!(classify("fetch".into(), String::new(), "Host key verification failed.\n"), GitError::HostUnknown(h) if h.is_empty()));
        let changed = "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.\n";
        assert!(matches!(classify("fetch".into(), String::new(), changed), GitError::AuthFailed(_)));
    }
}

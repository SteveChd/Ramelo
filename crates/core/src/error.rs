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
            Self::PushRejected(_) => "push_rejected",
            Self::AuthFailed(_) => "auth_failed",
            Self::BranchNotMerged(_) => "branch_not_merged",
            Self::InvalidBranchName(_) => "invalid_branch_name",
            Self::NothingToCommit => "nothing_to_commit",
            Self::NoRemote => "no_remote",
            Self::NoUpstream(_) => "no_upstream",
            Self::DetachedHead => "detached_head",
            Self::Conflicts => "conflicts",
        }
    }

    /// What the error is about (a folder, a command), to insert in the translated message.
    pub fn subject(&self) -> Option<String> {
        match self {
            Self::GitNotFound | Self::IdentityMissing | Self::Diverged | Self::NothingToCommit | Self::NoRemote | Self::Conflicts => None,
            Self::LocalChanges(detail) | Self::PushRejected(detail) | Self::AuthFailed(detail) => Some(detail.clone()),
            Self::BranchNotMerged(name) | Self::InvalidBranchName(name) | Self::NoUpstream(name) => Some(name.clone()),
            Self::DetachedHead => None,
            Self::PathMissing(path) | Self::NotARepository(path) | Self::NoRepositoryFound(path) => {
                Some(path.display().to_string())
            }
            Self::Io { path, .. } => Some(path.display().to_string()),
            Self::Failed { command, .. } | Self::Parse { command, .. } => Some(command.clone()),
        }
    }
}

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
    } else if any(&["Authentication failed", "could not read Username", "Permission denied (publickey", "terminal prompts disabled", "Host key verification failed"]) {
        GitError::AuthFailed(message)
    } else if let Some(name) = output.split("branch '").nth(1).filter(|_| output.contains("is not fully merged")) {
        GitError::BranchNotMerged(name.split('\'').next().unwrap_or_default().to_owned())
    } else {
        GitError::Failed { command, message }
    }
}

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
        }
    }

    /// What the error is about (a folder, a command), to insert in the translated message.
    pub fn subject(&self) -> Option<String> {
        match self {
            Self::GitNotFound => None,
            Self::PathMissing(path) | Self::NotARepository(path) | Self::NoRepositoryFound(path) => {
                Some(path.display().to_string())
            }
            Self::Io { path, .. } => Some(path.display().to_string()),
            Self::Failed { command, .. } | Self::Parse { command, .. } => Some(command.clone()),
        }
    }
}

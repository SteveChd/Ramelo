//! Error sent to the interface: a stable code that the interface translates, what the error is about
//! (a folder, a git command…), and an English fallback message.

use ramelo_core::GitError;
use ramelo_storage::StorageError;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    code: &'static str,
    subject: Option<String>,
    message: String,
}

impl CommandError {
    pub fn new(code: &'static str, subject: Option<String>, message: impl Into<String>) -> Self {
        Self { code, subject, message: message.into() }
    }
}

impl From<GitError> for CommandError {
    fn from(error: GitError) -> Self {
        Self { code: error.code(), subject: error.subject(), message: error.to_string() }
    }
}

impl From<StorageError> for CommandError {
    fn from(error: StorageError) -> Self {
        Self { code: error.code(), subject: error.subject(), message: error.to_string() }
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

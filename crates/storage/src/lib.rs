//! Storage of Ramelo: the workspace (the repositories the user manages and the active one),
//! kept in the user's data folder between sessions.

mod atomic;
mod error;
mod workspace;

pub use error::StorageError;
pub use workspace::{RepoEntry, Workspace};

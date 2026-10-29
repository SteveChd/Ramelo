//! Storage of Ramelo: the workspace (the repositories the user manages and the active one) and the
//! accounts on hosting services, kept in the user's data folder between sessions.

mod accounts;
mod atomic;
mod error;
mod workspace;

pub use accounts::{Account, Accounts, Provider};
pub use error::StorageError;
pub use workspace::{RepoEntry, Section, Workspace};

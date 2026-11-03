//! Storage of Ramelo: the workspace (the repositories the user manages and the active one) and the
//! accounts on hosting services, kept in the user's data folder between sessions, and the pull
//! requests already read.

mod accounts;
mod atomic;
mod error;
mod pull_cache;
mod workspace;

pub use accounts::{Account, Accounts, Provider};
pub use error::StorageError;
pub use pull_cache::{Cached, CachedPull, PullCache};
pub use workspace::{RepoEntry, Section, Workspace};

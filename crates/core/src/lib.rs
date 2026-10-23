//! Core of GitController: runs git, reads the state of repositories and finds them on disk.
//!
//! Every git operation goes through the `git` command line ([`Git`]), so the application behaves
//! exactly like the user's own git: same configuration, credentials, hooks and worktrees.

mod error;
mod git;
mod repo;
mod scan;
mod status;

pub use error::GitError;
pub use git::Git;
pub use repo::{open, summary, CommitInfo, Operation, RepoLocation, RepoSummary};
pub use scan::{scan, ScanLimits};
pub use status::{parse_status, ChangeKind, FileChange, Head, RepoStatus};

//! Core of Ramelo: runs git, reads the state of repositories and finds them on disk.
//!
//! Every git operation goes through the `git` command line ([`Git`]), so the application behaves
//! exactly like the user's own git: same configuration, credentials, hooks and worktrees.

mod branches;
mod conflicts;
mod content;
mod diff;
mod error;
mod git;
mod graph;
mod log;
mod remote;
mod repo;
mod rewrite;
mod scan;
mod search;
mod status;
mod worktree;

pub use branches::{Branch, Carried, RefList, Tag};
pub use conflicts::{abort_operation, conflict_file, continue_operation, resolve_file, skip_commit, take_side, ConflictFile, Progress, Segment, Side, Sides};
pub use content::{file_content, Content, Version, MAX_CONTENT};
pub use diff::{commit_details, commit_file_diff, parse_diff, worktree_diff, CommitDetails, DiffLine, FileDiff, FileStatus, Hunk, LineKind};
pub use error::GitError;
pub use git::Git;
pub use graph::{layout, Edge, GraphRow};
pub use log::{log, Commit, RefKind, RefLabel};
pub use remote::{fetch, pull, push, PullMode, PullOutcome, PushOutcome};
pub use repo::{open, summary, CommitInfo, Operation, RepoLocation, RepoSummary};
pub use rewrite::{edit_file, reword, rewrite_info, squash, RewriteInfo, Rewritten, SquashInfo};
pub use scan::{scan, ScanLimits};
pub use search::{search, SearchQuery, SearchResult, SearchScope};
pub use status::{parse_status, ChangeKind, FileChange, Head, RepoStatus};
pub use worktree::{apply_hunk, commit, discard, last_message, stage, stage_all, unstage, unstage_all, HunkAction};

/// Branches and tags: `refs::list`, `refs::switch`…
pub mod refs {
    pub use crate::branches::{create, delete, list, switch, validate_name};
}

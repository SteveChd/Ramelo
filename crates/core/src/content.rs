//! Content of a file at one version: in the working copy, in the index, or in a commit. Used to show
//! images and previews (Markdown, HTML) next to a diff.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::Serialize;

use crate::{Git, GitError};

/// Files larger than this are not read: their size is enough to show.
pub const MAX_CONTENT: u64 = 16 * 1024 * 1024;

/// Where a version of a file is read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Version<'a> {
    /// The file on disk.
    Worktree,
    /// The staged version.
    Index,
    /// The version in a revision (« HEAD », an oid, « abc^ »…).
    Revision(&'a str),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Content {
    pub size: u64,
    /// `None` when the file is larger than [`MAX_CONTENT`].
    #[serde(skip)]
    pub bytes: Option<Vec<u8>>,
}

/// The file at `path` (relative to the root) in `version`; `None` when it does not exist there.
pub fn file_content(git: &Git, root: &Path, path: &str, version: Version) -> Result<Option<Content>, GitError> {
    let spec = match version {
        Version::Worktree => return worktree_content(&root.join(path)),
        Version::Index => format!(":{path}"),
        Version::Revision(rev) => format!("{rev}:{path}"),
    };
    // A missing file, or a revision without parent, is simply absent.
    let out = git.raw(root, &["cat-file", "-s", &spec])?;
    if !out.status.success() {
        return Ok(None);
    }
    let size = String::from_utf8_lossy(&out.stdout).trim().parse().map_err(|_| GitError::Parse { command: "cat-file".into(), detail: spec.clone() })?;
    if size > MAX_CONTENT {
        return Ok(Some(Content { size, bytes: None }));
    }
    let bytes = git.output(root, ["cat-file", "blob", &spec])?;
    Ok(Some(Content { size, bytes: Some(bytes) }))
}

fn worktree_content(path: &Path) -> Result<Option<Content>, GitError> {
    let meta = match fs::metadata(path) {
        Ok(meta) if meta.is_file() => meta,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(GitError::Io { path: path.to_path_buf(), source }),
    };
    if meta.len() > MAX_CONTENT {
        return Ok(Some(Content { size: meta.len(), bytes: None }));
    }
    let bytes = fs::read(path).map_err(|source| GitError::Io { path: path.to_path_buf(), source })?;
    Ok(Some(Content { size: bytes.len() as u64, bytes: Some(bytes) }))
}

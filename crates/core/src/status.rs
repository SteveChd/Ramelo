//! State of the working copy, read from `git status --porcelain=v2 --branch --show-stash -z`.
//!
//! The v2 format is meant for tools: it is stable across git versions and languages, and gives the
//! branch, its upstream and the ahead / behind counts in the same call as the changed files.

use serde::Serialize;

use crate::GitError;

/// What happened to a file, on one side (index or working tree).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Unmodified,
    Modified,
    TypeChanged,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Ignored,
    /// Both sides of a merge or rebase changed the file: it must be resolved.
    Conflicted,
}

impl ChangeKind {
    fn from_code(code: u8) -> Self {
        match code {
            b'M' => Self::Modified,
            b'T' => Self::TypeChanged,
            b'A' => Self::Added,
            b'D' => Self::Deleted,
            b'R' => Self::Renamed,
            b'C' => Self::Copied,
            _ => Self::Unmodified,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// Former path of a renamed or copied file.
    pub orig_path: Option<String>,
    /// Change recorded in the index (what the next commit will contain).
    pub index: ChangeKind,
    /// Change in the working tree that is not staged yet.
    pub worktree: ChangeKind,
}

impl FileChange {
    pub fn is_staged(&self) -> bool {
        !matches!(self.index, ChangeKind::Unmodified | ChangeKind::Untracked | ChangeKind::Ignored | ChangeKind::Conflicted)
    }

    pub fn is_unstaged(&self) -> bool {
        matches!(self.worktree, ChangeKind::Modified | ChangeKind::TypeChanged | ChangeKind::Deleted)
    }
}

/// Where HEAD points.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    /// Current branch; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Commit of HEAD; `None` in a repository without any commit yet.
    pub oid: Option<String>,
}

impl Head {
    pub fn is_detached(&self) -> bool {
        self.branch.is_none()
    }

    /// The branch exists but has no commit yet (new repository).
    pub fn is_unborn(&self) -> bool {
        self.oid.is_none()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub head: Head,
    /// Upstream branch, for example « origin/main ».
    pub upstream: Option<String>,
    /// Commits on the branch that are not on its upstream yet (to push).
    pub ahead: u32,
    /// Commits on the upstream that are not on the branch yet (to pull).
    pub behind: u32,
    pub stashes: u32,
    pub files: Vec<FileChange>,
}

impl RepoStatus {
    pub fn staged(&self) -> usize {
        self.files.iter().filter(|f| f.is_staged()).count()
    }

    pub fn unstaged(&self) -> usize {
        self.files.iter().filter(|f| f.is_unstaged()).count()
    }

    pub fn untracked(&self) -> usize {
        self.files.iter().filter(|f| f.worktree == ChangeKind::Untracked).count()
    }

    pub fn conflicted(&self) -> usize {
        self.files.iter().filter(|f| f.index == ChangeKind::Conflicted).count()
    }

    /// Nothing to commit: no change, staged or not, and no untracked file.
    pub fn is_clean(&self) -> bool {
        self.files.is_empty()
    }
}

/// Arguments of the `git status` call that [`parse_status`] reads.
pub(crate) const STATUS_ARGS: [&str; 6] =
    ["status", "--porcelain=v2", "--branch", "--show-stash", "--untracked-files=all", "-z"];

/// Reads the output of `git status --porcelain=v2 --branch --show-stash -z`.
pub fn parse_status(output: &[u8]) -> Result<RepoStatus, GitError> {
    let mut status = RepoStatus::default();
    let mut records = output.split(|b| *b == 0).filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        let line = String::from_utf8_lossy(record);
        let bad = || GitError::Parse { command: "status".into(), detail: line.to_string() };
        match record[0] {
            b'#' => parse_header(&line, &mut status).ok_or_else(bad)?,
            // Ordinary change: « 1 XY sub mH mI mW hH hI path ».
            b'1' => {
                let (xy, path) = fields(&line, 8).ok_or_else(bad)?;
                status.files.push(change(xy, path, None));
            }
            // Rename or copy: « 2 XY sub mH mI mW hH hI Xscore path », then the former path.
            b'2' => {
                let (xy, path) = fields(&line, 9).ok_or_else(bad)?;
                let orig = records.next().map(|r| String::from_utf8_lossy(r).into_owned());
                status.files.push(change(xy, path, orig));
            }
            // Unmerged: « u XY sub m1 m2 m3 mW h1 h2 h3 path ».
            b'u' => {
                let (_, path) = fields(&line, 10).ok_or_else(bad)?;
                status.files.push(FileChange {
                    path: path.to_owned(),
                    orig_path: None,
                    index: ChangeKind::Conflicted,
                    worktree: ChangeKind::Conflicted,
                });
            }
            b'?' | b'!' => {
                let kind = if record[0] == b'?' { ChangeKind::Untracked } else { ChangeKind::Ignored };
                let path = line.get(2..).ok_or_else(bad)?;
                status.files.push(FileChange { path: path.to_owned(), orig_path: None, index: kind, worktree: kind });
            }
            _ => return Err(bad()),
        }
    }
    Ok(status)
}

/// « # branch.head main », « # branch.ab +2 -1 »… Unknown headers are ignored (newer git).
fn parse_header(line: &str, status: &mut RepoStatus) -> Option<()> {
    let mut words = line.trim_start_matches("# ").splitn(2, ' ');
    let key = words.next()?;
    let value = words.next().unwrap_or_default();
    match key {
        "branch.oid" => status.head.oid = (value != "(initial)").then(|| value.to_owned()),
        "branch.head" => status.head.branch = (value != "(detached)").then(|| value.to_owned()),
        "branch.upstream" => status.upstream = Some(value.to_owned()),
        "branch.ab" => {
            let (ahead, behind) = value.split_once(' ')?;
            status.ahead = ahead.strip_prefix('+')?.parse().ok()?;
            status.behind = behind.strip_prefix('-')?.parse().ok()?;
        }
        "stash" => status.stashes = value.parse().ok()?,
        _ => {}
    }
    Some(())
}

/// The XY field and the path, which comes after `before_path` space-separated fields (and may itself
/// contain spaces).
fn fields(line: &str, before_path: usize) -> Option<(&[u8], &str)> {
    let mut parts = line.splitn(before_path + 1, ' ');
    let xy = parts.nth(1)?.as_bytes();
    let path = parts.nth(before_path - 2)?;
    (xy.len() == 2).then_some((xy, path))
}

fn change(xy: &[u8], path: &str, orig_path: Option<String>) -> FileChange {
    FileChange {
        path: path.to_owned(),
        orig_path,
        index: ChangeKind::from_code(xy[0]),
        worktree: ChangeKind::from_code(xy[1]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(records: &[&str]) -> RepoStatus {
        let mut bytes = records.join("\0").into_bytes();
        bytes.push(0);
        parse_status(&bytes).unwrap()
    }

    #[test]
    fn reads_the_branch_its_upstream_and_the_stashes() {
        let status = parse(&[
            "# branch.oid 1f2e3d4c5b6a",
            "# branch.head feature/login",
            "# branch.upstream origin/feature/login",
            "# branch.ab +3 -12",
            "# stash 2",
        ]);
        assert_eq!(status.head.branch.as_deref(), Some("feature/login"));
        assert_eq!(status.head.oid.as_deref(), Some("1f2e3d4c5b6a"));
        assert_eq!(status.upstream.as_deref(), Some("origin/feature/login"));
        assert_eq!((status.ahead, status.behind, status.stashes), (3, 12, 2));
        assert!(status.is_clean());
    }

    #[test]
    fn reads_a_new_repository_and_a_detached_head() {
        let new = parse(&["# branch.oid (initial)", "# branch.head main"]);
        assert!(new.head.is_unborn() && !new.head.is_detached());
        let detached = parse(&["# branch.oid abc", "# branch.head (detached)"]);
        assert!(detached.head.is_detached() && !detached.head.is_unborn());
        assert_eq!(detached.upstream, None);
    }

    #[test]
    fn reads_every_kind_of_change_including_paths_with_spaces() {
        let status = parse(&[
            "# branch.oid abc",
            "# branch.head main",
            "1 M. N... 100644 100644 100644 aaa bbb src/main file.rs",
            "1 .D N... 100644 100644 000000 aaa aaa gone.txt",
            "1 AM N... 000000 100644 100644 000 ccc new.rs",
            "2 R. N... 100644 100644 100644 aaa aaa R100 docs/guide.md",
            "docs/old guide.md",
            "u UU N... 100644 100644 100644 100644 a b c both.rs",
            "? notes/todo é.txt",
        ]);
        let kinds: Vec<_> = status.files.iter().map(|f| (f.path.as_str(), f.index, f.worktree)).collect();
        assert_eq!(
            kinds,
            [
                ("src/main file.rs", ChangeKind::Modified, ChangeKind::Unmodified),
                ("gone.txt", ChangeKind::Unmodified, ChangeKind::Deleted),
                ("new.rs", ChangeKind::Added, ChangeKind::Modified),
                ("docs/guide.md", ChangeKind::Renamed, ChangeKind::Unmodified),
                ("both.rs", ChangeKind::Conflicted, ChangeKind::Conflicted),
                ("notes/todo é.txt", ChangeKind::Untracked, ChangeKind::Untracked),
            ]
        );
        assert_eq!(status.files[3].orig_path.as_deref(), Some("docs/old guide.md"));
        assert_eq!((status.staged(), status.unstaged(), status.untracked(), status.conflicted()), (3, 2, 1, 1));
    }

    #[test]
    fn rejects_garbage_and_ignores_unknown_headers() {
        assert!(parse_status(b"# branch.future thing\0").is_ok());
        assert!(matches!(parse_status(b"1 M\0"), Err(GitError::Parse { .. })));
        assert!(matches!(parse_status(b"Z what\0"), Err(GitError::Parse { .. })));
    }
}

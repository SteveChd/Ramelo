//! Differences, read from git's unified diff output: of a working-copy file (staged or not), and of
//! a commit. A hunk can be turned back into a patch to stage, unstage or discard only that part of a
//! file.

use std::path::Path;

use serde::Serialize;

use crate::{Git, GitError};

/// Beyond this many lines, the lines of a file are not kept (the counts stay exact): a generated
/// file or a minified bundle would otherwise flood the interface.
pub(crate) const MAX_LINES_PER_FILE: usize = 8000;
/// Same limit, for all the files of a commit together.
pub(crate) const MAX_LINES_PER_COMMIT: usize = 30000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Added,
    Deleted,
    /// « \ No newline at end of file », about the line before it.
    NoNewline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    /// Line number in the old version (context and deleted lines).
    pub old: Option<u32>,
    /// Line number in the new version (context and added lines).
    pub new: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// The « @@ -1,2 +1,3 @@ fn name » line.
    pub header: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub binary: bool,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<Hunk>,
    /// The lines were too many to be kept; `hunks` is empty.
    pub truncated: bool,
    /// Header lines of the diff (« diff --git… » up to the first hunk), to rebuild a patch.
    #[serde(skip)]
    pub header: String,
}

impl FileDiff {
    /// A patch that contains only hunk `index` of this file, for `git apply`.
    pub fn hunk_patch(&self, index: usize) -> Option<String> {
        let hunk = self.hunks.get(index)?;
        let mut patch = self.header.clone();
        patch.push_str(&hunk.header);
        patch.push('\n');
        for line in &hunk.lines {
            let prefix = match line.kind {
                LineKind::Context => ' ',
                LineKind::Added => '+',
                LineKind::Deleted => '-',
                LineKind::NoNewline => '\\',
            };
            patch.push(prefix);
            patch.push_str(&line.text);
            patch.push('\n');
        }
        Some(patch)
    }
}

/// Changes of a working-copy file: the staged ones (`staged`), or those not staged yet. An untracked
/// file is shown as entirely added.
pub fn worktree_diff(git: &Git, root: &Path, path: &str, staged: bool, untracked: bool) -> Result<Option<FileDiff>, GitError> {
    let out = if untracked {
        // `--no-index` exits with 1 when the files differ, which is always the case here.
        let args = ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", path];
        let out = git.raw(root, &args)?;
        if out.status.code() != Some(1) {
            return Err(GitError::Failed { command: args.join(" "), message: String::from_utf8_lossy(&out.stderr).trim().to_owned() });
        }
        out.stdout
    } else {
        let mut args = vec!["diff", "--no-ext-diff", "-M"];
        if staged {
            args.push("--cached");
        }
        args.extend(["--", path]);
        git.output(root, &args)?
    };
    Ok(parse_diff(&String::from_utf8_lossy(&out), MAX_LINES_PER_FILE).into_iter().next())
}

/// Everything about one commit: its message and authorship, and what it changed (against its first
/// parent for a merge).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub message: String,
    pub files: Vec<FileDiff>,
}

pub fn commit_details(git: &Git, root: &Path, oid: &str) -> Result<CommitDetails, GitError> {
    let meta = git.text(root, ["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B", oid])?;
    let bad = || GitError::Parse { command: "show".into(), detail: meta.clone() };
    let fields: Vec<&str> = meta.splitn(8, '\x1f').collect();
    let [oid, parents, author, email, time, committer, commit_time, message] = fields[..] else { return Err(bad()) };
    let patch = git.output(root, ["show", "--format=", "--no-ext-diff", "-M", "--diff-merges=first-parent", oid])?;
    Ok(CommitDetails {
        oid: oid.to_owned(),
        parents: parents.split_whitespace().map(str::to_owned).collect(),
        author: author.to_owned(),
        email: email.to_owned(),
        time: time.parse().map_err(|_| bad())?,
        committer: committer.to_owned(),
        commit_time: commit_time.parse().map_err(|_| bad())?,
        message: message.trim_end().to_owned(),
        files: parse_diff(&String::from_utf8_lossy(&patch), MAX_LINES_PER_COMMIT),
    })
}

/// One file of a commit, in full (when the commit's own diff had to be cut).
pub fn commit_file_diff(git: &Git, root: &Path, oid: &str, path: &str) -> Result<Option<FileDiff>, GitError> {
    let patch = git.output(root, ["show", "--format=", "--no-ext-diff", "-M", "--diff-merges=first-parent", oid, "--", path])?;
    Ok(parse_diff(&String::from_utf8_lossy(&patch), MAX_LINES_PER_FILE).into_iter().next())
}

/// Reads `git diff` output. Lines beyond `max_lines` (all files together) are counted, not kept.
pub fn parse_diff(text: &str, max_lines: usize) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut kept = 0;
    let mut in_header = false;
    let (mut old_no, mut new_no) = (0u32, 0u32);

    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            files.push(FileDiff {
                path: header_path(rest),
                old_path: None,
                status: FileStatus::Modified,
                binary: false,
                additions: 0,
                deletions: 0,
                hunks: Vec::new(),
                truncated: false,
                header: format!("{line}\n"),
            });
            in_header = true;
            continue;
        }
        let Some(file) = files.last_mut() else { continue };

        if in_header {
            if line.starts_with("@@") {
                in_header = false;
            } else {
                file.header.push_str(line);
                file.header.push('\n');
                read_header_line(file, line);
                continue;
            }
        }

        if line.starts_with("@@") {
            let (old_start, new_start) = hunk_starts(line);
            (old_no, new_no) = (old_start, new_start);
            if !file.truncated {
                file.hunks.push(Hunk { header: line.to_owned(), old_start, new_start, lines: Vec::new() });
            }
            continue;
        }
        let (kind, text) = match line.as_bytes().first() {
            Some(b' ') => (LineKind::Context, &line[1..]),
            Some(b'+') => (LineKind::Added, &line[1..]),
            Some(b'-') => (LineKind::Deleted, &line[1..]),
            Some(b'\\') => (LineKind::NoNewline, &line[1..]),
            // The empty string after the last newline.
            _ => continue,
        };
        let (old, new) = match kind {
            LineKind::Context => (Some(old_no), Some(new_no)),
            LineKind::Added => (None, Some(new_no)),
            LineKind::Deleted => (Some(old_no), None),
            LineKind::NoNewline => (None, None),
        };
        match kind {
            LineKind::Context => (old_no, new_no) = (old_no + 1, new_no + 1),
            LineKind::Added => {
                new_no += 1;
                file.additions += 1;
            }
            LineKind::Deleted => {
                old_no += 1;
                file.deletions += 1;
            }
            LineKind::NoNewline => {}
        }
        if file.truncated {
            continue;
        }
        if kept >= max_lines {
            file.truncated = true;
            file.hunks.clear();
            continue;
        }
        kept += 1;
        if let Some(hunk) = file.hunks.last_mut() {
            hunk.lines.push(DiffLine { kind, old, new, text: text.to_owned() });
        }
    }
    files
}

fn read_header_line(file: &mut FileDiff, line: &str) {
    if line.starts_with("new file mode") {
        file.status = FileStatus::Added;
    } else if line.starts_with("deleted file mode") {
        file.status = FileStatus::Deleted;
    } else if let Some(from) = line.strip_prefix("rename from ") {
        file.status = FileStatus::Renamed;
        file.old_path = Some(unquote(from));
    } else if let Some(to) = line.strip_prefix("rename to ") {
        file.path = unquote(to);
    } else if let Some(from) = line.strip_prefix("copy from ") {
        file.status = FileStatus::Copied;
        file.old_path = Some(unquote(from));
    } else if let Some(to) = line.strip_prefix("copy to ") {
        file.path = unquote(to);
    } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
        file.binary = true;
    } else if let Some(new) = line.strip_prefix("+++ ") {
        // The « --- » side only differs for a rename, which the « rename from » line already gives.
        if let Some(path) = side_path(new) {
            file.path = path;
        }
    }
}

/// « a/path » or « b/path » on a ---/+++ line (git adds a tab after a path with spaces); `None` for
/// /dev/null.
fn side_path(value: &str) -> Option<String> {
    let value = unquote(value.trim_end_matches('\t'));
    if value == "/dev/null" {
        return None;
    }
    Some(value.get(2..).unwrap_or(&value).to_owned())
}

/// Path from « a/<p> b/<p> », used until the ---/+++ lines (absent for binary or mode-only changes)
/// say better. Both halves are the same path when the file is not renamed.
fn header_path(rest: &str) -> String {
    if rest.starts_with('"') {
        return rest.rsplit_once(" \"b/").map_or_else(|| unquote(rest), |(_, b)| unquote(&format!("\"{b}")));
    }
    let half = rest.len().saturating_sub(1) / 2;
    match (rest.get(..half), rest.get(half + 1..)) {
        (Some(a), Some(b)) if a.get(2..) == b.get(2..) => b[2..].to_owned(),
        _ => rest.rsplit_once(" b/").map_or_else(|| rest.to_owned(), |(_, b)| b.to_owned()),
    }
}

/// « @@ -12,3 +12,4 @@ » → (12, 12).
fn hunk_starts(header: &str) -> (u32, u32) {
    let mut parts = header.split_whitespace().skip(1);
    let start = |part: Option<&str>| part.and_then(|p| p[1..].split(',').next()?.parse().ok()).unwrap_or(0);
    (start(parts.next()), start(parts.next()))
}

/// Git quotes paths with unusual characters: « "dir/caf\303\251.txt" ».
fn unquote(value: &str) -> String {
    let Some(inner) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) else { return value.to_owned() };
    let mut bytes = Vec::new();
    let mut chars = inner.bytes().peekable();
    while let Some(b) = chars.next() {
        if b != b'\\' {
            bytes.push(b);
            continue;
        }
        match chars.next() {
            Some(b'n') => bytes.push(b'\n'),
            Some(b't') => bytes.push(b'\t'),
            Some(d @ b'0'..=b'7') => {
                let mut code = u32::from(d - b'0');
                for _ in 0..2 {
                    if let Some(&n @ b'0'..=b'7') = chars.peek() {
                        code = code * 8 + u32::from(n - b'0');
                        chars.next();
                    }
                }
                bytes.push(code as u8);
            }
            Some(other) => bytes.push(other),
            None => {}
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "diff --git a/my file.txt b/my file.txt
index 422c2b7..7be73ce 100644
--- a/my file.txt\t
+++ b/my file.txt\t
@@ -1,2 +1,3 @@ intro
 a
-b
+B
+c
@@ -10 +11 @@
-x
\\ No newline at end of file
+y
\\ No newline at end of file
diff --git a/old.rs b/new.rs
similarity index 90%
rename from old.rs
rename to new.rs
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..3e75765
Binary files /dev/null and b/logo.png differ
";

    #[test]
    fn reads_files_hunks_and_line_numbers() {
        let files = parse_diff(SAMPLE, 1000);
        assert_eq!(files.len(), 3);
        let first = &files[0];
        assert_eq!((first.path.as_str(), first.status, first.additions, first.deletions), ("my file.txt", FileStatus::Modified, 3, 2));
        assert_eq!(first.hunks.len(), 2);
        let numbers: Vec<_> = first.hunks[0].lines.iter().map(|l| (l.kind, l.old, l.new)).collect();
        assert_eq!(
            numbers,
            [
                (LineKind::Context, Some(1), Some(1)),
                (LineKind::Deleted, Some(2), None),
                (LineKind::Added, None, Some(2)),
                (LineKind::Added, None, Some(3)),
            ]
        );
        assert_eq!(first.hunks[1].lines[1].kind, LineKind::NoNewline);
        assert_eq!((first.hunks[1].old_start, first.hunks[1].new_start), (10, 11));

        assert_eq!((files[1].path.as_str(), files[1].old_path.as_deref(), files[1].status), ("new.rs", Some("old.rs"), FileStatus::Renamed));
        assert!(files[2].binary && files[2].status == FileStatus::Added && files[2].path == "logo.png");
    }

    #[test]
    fn rebuilds_the_patch_of_one_hunk() {
        let files = parse_diff(SAMPLE, 1000);
        let patch = files[0].hunk_patch(1).unwrap();
        assert!(patch.starts_with("diff --git a/my file.txt b/my file.txt\nindex 422c2b7..7be73ce 100644\n--- a/my file.txt\t\n"));
        assert!(patch.ends_with("@@ -10 +11 @@\n-x\n\\ No newline at end of file\n+y\n\\ No newline at end of file\n"));
        assert_eq!(files[0].hunk_patch(2), None);
    }

    #[test]
    fn stops_keeping_lines_past_the_limit_but_keeps_counting() {
        let files = parse_diff(SAMPLE, 3);
        assert!(files[0].truncated && files[0].hunks.is_empty());
        assert_eq!((files[0].additions, files[0].deletions), (3, 2));
    }

    #[test]
    fn decodes_quoted_paths() {
        assert_eq!(unquote("\"caf\\303\\251 \\\"x\\\".txt\""), "café \"x\".txt");
        assert_eq!(header_path("\"a/caf\\303\\251\" \"b/caf\\303\\251\""), "café");
        assert_eq!(header_path("a/x y b/x y"), "x y");
    }
}

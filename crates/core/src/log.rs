//! History of a repository: the commits of every branch, remote branch and tag, newest first, with
//! the references that point to each one.

use std::path::Path;

use serde::Serialize;

use crate::{Git, GitError};

/// Kind of reference shown as a label next to a commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    /// A local branch.
    Branch,
    /// A remote-tracking branch, such as « origin/main ».
    Remote,
    Tag,
    /// HEAD itself, when it is detached.
    Head,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub kind: RefKind,
    /// Short name: « main », « origin/main », « v1.0 ».
    pub name: String,
    /// The branch HEAD is on.
    pub is_head: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Author time, in seconds since the Unix epoch.
    pub time: i64,
    pub summary: String,
    pub refs: Vec<RefLabel>,
}

const FIELDS: &str = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s";

/// Up to `limit` commits after skipping `skip`, children always before their parents.
pub fn log(git: &Git, root: &Path, limit: usize, skip: usize) -> Result<Vec<Commit>, GitError> {
    let args = [
        "log".to_owned(),
        "--branches".into(),
        "--remotes".into(),
        "--tags".into(),
        "HEAD".into(),
        "--date-order".into(),
        "--decorate=full".into(),
        "-z".into(),
        format!("--format={FIELDS}"),
        format!("--max-count={limit}"),
        format!("--skip={skip}"),
    ];
    let out = match git.output(root, &args) {
        Ok(out) => out,
        // A repository without any commit has no history (HEAD points to an unborn branch).
        Err(GitError::Failed { message, .. }) if message.contains("does not have any commits") || message.contains("unknown revision") => {
            return Ok(Vec::new());
        }
        Err(error) => return Err(error),
    };
    String::from_utf8_lossy(&out)
        .split('\0')
        .map(|r| r.trim_start_matches('\n'))
        .filter(|r| !r.is_empty())
        .map(parse_commit)
        .collect()
}

fn parse_commit(record: &str) -> Result<Commit, GitError> {
    let bad = || GitError::Parse { command: "log".into(), detail: record.to_owned() };
    let fields: Vec<&str> = record.splitn(7, '\x1f').collect();
    let [oid, parents, author, email, time, refs, summary] = fields[..] else { return Err(bad()) };
    Ok(Commit {
        oid: oid.to_owned(),
        parents: parents.split_whitespace().map(str::to_owned).collect(),
        author: author.to_owned(),
        email: email.to_owned(),
        time: time.parse().map_err(|_| bad())?,
        summary: summary.to_owned(),
        refs: parse_refs(refs),
    })
}

/// « HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1 » with `--decorate=full`.
pub(crate) fn parse_refs(decoration: &str) -> Vec<RefLabel> {
    let mut labels = Vec::new();
    for part in decoration.split(", ").map(str::trim).filter(|p| !p.is_empty()) {
        let (is_head, name) = match part.strip_prefix("HEAD -> ") {
            Some(rest) => (true, rest),
            None => (false, part),
        };
        let name = name.strip_prefix("tag: ").unwrap_or(name);
        let label = if let Some(branch) = name.strip_prefix("refs/heads/") {
            RefLabel { kind: RefKind::Branch, name: branch.to_owned(), is_head }
        } else if let Some(remote) = name.strip_prefix("refs/remotes/") {
            // « origin/HEAD » only repeats the default branch of the remote.
            if remote.ends_with("/HEAD") {
                continue;
            }
            RefLabel { kind: RefKind::Remote, name: remote.to_owned(), is_head: false }
        } else if let Some(tag) = name.strip_prefix("refs/tags/") {
            RefLabel { kind: RefKind::Tag, name: tag.to_owned(), is_head: false }
        } else if name == "HEAD" {
            RefLabel { kind: RefKind::Head, name: "HEAD".to_owned(), is_head: true }
        } else {
            continue;
        };
        labels.push(label);
    }
    labels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_branch_remote_tag_and_head_labels() {
        let labels = parse_refs("HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0, refs/heads/feature/x");
        let short: Vec<_> = labels.iter().map(|l| (l.kind, l.name.as_str(), l.is_head)).collect();
        assert_eq!(
            short,
            [
                (RefKind::Branch, "main", true),
                (RefKind::Remote, "origin/main", false),
                (RefKind::Tag, "v1.0", false),
                (RefKind::Branch, "feature/x", false),
            ]
        );
        assert_eq!(parse_refs("HEAD")[0].kind, RefKind::Head);
        assert!(parse_refs("").is_empty());
    }

    #[test]
    fn reads_a_record_with_separators_in_the_summary() {
        let commit = parse_commit("abc\x1fp1 p2\x1fSteve\x1fs@x.fr\x1f1700000000\x1f\x1fFix: a\x1fb").unwrap();
        assert_eq!(commit.parents, ["p1", "p2"]);
        assert_eq!(commit.summary, "Fix: a\x1fb");
        assert!(commit.refs.is_empty());
    }
}

//! Rewriting the history of the current branch without an interactive rebase: changing the message
//! of a past commit, or the content of one of its files.
//!
//! The commit and every commit after it up to HEAD are written again as new objects (same author,
//! same messages, the user as committer), then HEAD moves to the new tip with `reset --keep`, which
//! updates the working copy and refuses to overwrite local changes. Nothing changes until that last
//! step: a conflict or an error leaves the repository as it was, and the old commits stay in the
//! reflog.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::repo::Operation;
use crate::{Git, GitError};

/// Whether a commit can be rewritten, and what it would take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteInfo {
    /// The commit is in the history of HEAD and no operation is in progress.
    pub editable: bool,
    /// Commits after it that will be written again.
    pub descendants: usize,
    /// Remote branches that already contain it: they will need a force push.
    pub pushed_to: Vec<String>,
}

pub fn rewrite_info(git: &Git, root: &Path, oid: &str) -> Result<RewriteInfo, GitError> {
    let editable = operation(git, root)?.is_none() && is_ancestor_of_head(git, root, oid)?;
    let descendants = if editable { descendants(git, root, oid)?.len() } else { 0 };
    let pushed_to = git
        .text(root, ["for-each-ref", "--contains", oid, "--format=%(refname:short)", "refs/remotes"])?
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.ends_with("/HEAD"))
        .map(str::to_owned)
        .collect();
    Ok(RewriteInfo { editable, descendants, pushed_to })
}

/// The history after a rewrite.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rewritten {
    pub head: String,
    /// The new version of the commit that was changed.
    pub commit: String,
}

/// Gives commit `oid` a new message.
pub fn reword(git: &Git, root: &Path, oid: &str, message: &str) -> Result<Rewritten, GitError> {
    let message = message.trim_end();
    if message.trim().is_empty() {
        return Err(GitError::NothingToCommit);
    }
    rewrite(git, root, oid, Change::Message(format!("{message}\n")))
}

/// Replaces the content of `path` in commit `oid`; the commits after it keep their own changes to
/// the file, merged on top.
pub fn edit_file(git: &Git, root: &Path, oid: &str, path: &str, content: &[u8]) -> Result<Rewritten, GitError> {
    rewrite(git, root, oid, Change::File { path: path.to_owned(), content: content.to_vec() })
}

enum Change {
    Message(String),
    File { path: String, content: Vec<u8> },
}

fn rewrite(git: &Git, root: &Path, oid: &str, change: Change) -> Result<Rewritten, GitError> {
    if operation(git, root)?.is_some() {
        return Err(GitError::OperationInProgress);
    }
    let oid = git.text(root, ["rev-parse", "--verify", &format!("{oid}^{{commit}}")])?.trim().to_owned();
    if !is_ancestor_of_head(git, root, &oid)? {
        return Err(GitError::NotInHistory(short(&oid)));
    }
    let head = git.text(root, ["rev-parse", "HEAD"])?.trim().to_owned();
    let committer = git.text(root, ["var", "GIT_COMMITTER_IDENT"]).map_err(|_| GitError::IdentityMissing)?.trim().to_owned();

    // Old commit → new commit, for the parents of the commits written after it.
    let mut rewritten: HashMap<String, String> = HashMap::new();
    let mut order = vec![oid.clone()];
    order.extend(descendants(git, root, &oid)?);
    for old in &order {
        let commit = RawCommit::read(git, root, old)?;
        let parents: Vec<String> = commit.parents.iter().map(|p| rewritten.get(p).cloned().unwrap_or_else(|| p.clone())).collect();
        let (tree, message) = match &change {
            Change::Message(message) if *old == oid => (commit.tree.clone(), message.as_bytes().to_vec()),
            Change::Message(_) => (commit.tree.clone(), commit.message.clone()),
            Change::File { path, content } if *old == oid => {
                let blob = git.output_with_input(root, &["hash-object", "-w", "--stdin"], content)?;
                let blob = String::from_utf8_lossy(&blob).trim().to_owned();
                let mode = entry(git, root, &commit.tree, path)?.map_or_else(|| "100644".to_owned(), |e| e.mode);
                (replace(git, root, &commit.tree, path, Some((&mode, &blob)))?, commit.message.clone())
            }
            Change::File { path, .. } => {
                // The commit's own change to the file (from its first parent), applied to the
                // rewritten first parent.
                let old_parent = commit.parents.first().cloned();
                let new_parent = parents.first().cloned();
                let tree = carry_file(git, root, &commit, old_parent.as_deref(), new_parent.as_deref(), path)?;
                (tree, commit.message.clone())
            }
        };
        // Nothing actually changes: the history is left alone.
        if *old == oid && tree == commit.tree && message == commit.message {
            return Ok(Rewritten { head, commit: oid });
        }
        let new = commit.write(git, root, &tree, &parents, &committer, &message)?;
        rewritten.insert(old.clone(), new);
    }

    let new_head = rewritten.get(&head).cloned().unwrap_or(head);
    let commit = rewritten.get(&oid).cloned().unwrap_or(oid);
    let out = git.raw(root, &["reset", "--quiet", "--keep", &new_head])?;
    if !out.status.success() {
        let message = String::from_utf8_lossy(&out.stderr);
        let file = message.lines().find_map(|l| l.split('\'').nth(1)).unwrap_or_default().to_owned();
        return Err(GitError::LocalChanges(file));
    }
    Ok(Rewritten { head: new_head, commit })
}

/// Tree of `commit` with `path` taking the content it would have after a rebase on `new_parent`.
fn carry_file(git: &Git, root: &Path, commit: &RawCommit, old_parent: Option<&str>, new_parent: Option<&str>, path: &str) -> Result<String, GitError> {
    let blob_in = |commit: Option<&str>| -> Result<Option<Entry>, GitError> {
        match commit {
            Some(c) => {
                let tree = git.text(root, ["rev-parse", &format!("{c}^{{tree}}")])?;
                entry(git, root, tree.trim(), path)
            }
            None => Ok(None),
        }
    };
    let base = blob_in(old_parent)?;
    let theirs = blob_in(new_parent)?;
    let ours = entry(git, root, &commit.tree, path)?;
    let same = |a: &Option<Entry>, b: &Option<Entry>| a.as_ref().map(|e| &e.oid) == b.as_ref().map(|e| &e.oid);
    // The commit did not touch the file: it takes the new version. The new parent has the old
    // version: the commit's own version stands.
    let result = if same(&ours, &base) {
        theirs
    } else if same(&theirs, &base) || same(&ours, &theirs) {
        ours.clone()
    } else {
        let (Some(base), Some(ours_entry), Some(theirs_entry)) = (&base, &ours, &theirs) else {
            return Err(GitError::RewriteConflict(path.to_owned()));
        };
        let merged = merge_file(git, root, &ours_entry.oid, &base.oid, &theirs_entry.oid, path)?;
        Some(Entry { mode: ours_entry.mode.clone(), oid: merged })
    };
    if same(&result, &ours) {
        return Ok(commit.tree.clone());
    }
    replace(git, root, &commit.tree, path, result.as_ref().map(|e| (e.mode.as_str(), e.oid.as_str())))
}

/// Three-way merge of one file's blobs; a conflict stops the rewrite.
fn merge_file(git: &Git, root: &Path, ours: &str, base: &str, theirs: &str, path: &str) -> Result<String, GitError> {
    let dir = std::env::temp_dir().join(format!("gitcontroller-merge-{}-{}", std::process::id(), short(ours)));
    fs::create_dir_all(&dir).map_err(|source| GitError::Io { path: dir.clone(), source })?;
    let result = (|| {
        let mut files = Vec::new();
        for (name, blob) in [("ours", ours), ("base", base), ("theirs", theirs)] {
            let file = dir.join(name);
            let bytes = git.output(root, ["cat-file", "blob", blob])?;
            fs::write(&file, bytes).map_err(|source| GitError::Io { path: file.clone(), source })?;
            files.push(file);
        }
        let args = ["merge-file".as_ref(), "-p".as_ref(), files[0].as_os_str(), files[1].as_os_str(), files[2].as_os_str()];
        let out = git.raw(root, &args)?;
        if !out.status.success() {
            return Err(GitError::RewriteConflict(path.to_owned()));
        }
        let blob = git.output_with_input(root, &["hash-object", "-w", "--stdin"], &out.stdout)?;
        Ok(String::from_utf8_lossy(&blob).trim().to_owned())
    })();
    let _ = fs::remove_dir_all(&dir);
    result
}

#[derive(Debug, Clone)]
struct Entry {
    mode: String,
    oid: String,
}

/// The entry at `path` (« dir/file ») in `tree`.
fn entry(git: &Git, root: &Path, tree: &str, path: &str) -> Result<Option<Entry>, GitError> {
    let out = git.output(root, ["ls-tree", "-z", tree, "--", path])?;
    Ok(String::from_utf8_lossy(&out).split('\0').find_map(|line| {
        let (meta, name) = line.split_once('\t')?;
        let mut parts = meta.split(' ');
        let (mode, kind, oid) = (parts.next()?, parts.next()?, parts.next()?);
        (name == path && kind == "blob").then(|| Entry { mode: mode.to_owned(), oid: oid.to_owned() })
    }))
}

/// `tree` with the blob at `path` replaced (`None`: removed), written as new tree objects.
fn replace(git: &Git, root: &Path, tree: &str, path: &str, blob: Option<(&str, &str)>) -> Result<String, GitError> {
    let (first, rest) = match path.split_once('/') {
        Some((dir, rest)) => (dir, Some(rest)),
        None => (path, None),
    };
    let listing = git.output(root, ["ls-tree", "-z", tree])?;
    let mut lines: Vec<String> = String::from_utf8_lossy(&listing).split('\0').filter(|l| !l.is_empty()).map(str::to_owned).collect();
    let position = lines.iter().position(|l| l.split_once('\t').is_some_and(|(_, name)| name == first));
    let new_line = match rest {
        None => blob.map(|(mode, oid)| format!("{mode} blob {oid}\t{first}")),
        Some(rest) => {
            let sub = position.and_then(|i| {
                let (meta, _) = lines[i].split_once('\t')?;
                meta.contains(" tree ").then(|| meta.rsplit(' ').next().unwrap_or_default().to_owned())
            });
            let empty = String::from_utf8_lossy(&git.output_with_input(root, &["mktree", "-z"], b"")?).trim().to_owned();
            let sub = replace(git, root, sub.as_deref().unwrap_or(&empty), rest, blob)?;
            // A folder left empty disappears, as in git.
            (sub != empty).then(|| format!("040000 tree {sub}\t{first}"))
        }
    };
    match (position, new_line) {
        (Some(i), Some(line)) => lines[i] = line,
        (Some(i), None) => {
            lines.remove(i);
        }
        (None, Some(line)) => lines.push(line),
        (None, None) => {}
    }
    let mut input = lines.join("\0").into_bytes();
    if !input.is_empty() {
        input.push(0);
    }
    Ok(String::from_utf8_lossy(&git.output_with_input(root, &["mktree", "-z"], &input)?).trim().to_owned())
}

/// A commit object as git stores it, so that it can be written again with only what changes.
struct RawCommit {
    tree: String,
    parents: Vec<String>,
    /// The other headers (author, encoding…), kept as they are; a signature is dropped since it would
    /// no longer match.
    headers: Vec<String>,
    message: Vec<u8>,
}

impl RawCommit {
    fn read(git: &Git, root: &Path, oid: &str) -> Result<Self, GitError> {
        let raw = git.output(root, ["cat-file", "commit", oid])?;
        let split = raw.windows(2).position(|w| w == b"\n\n").map_or(raw.len(), |i| i + 2);
        let head = String::from_utf8_lossy(&raw[..split]).into_owned();
        let message = raw.get(split..).unwrap_or_default().to_vec();
        let (mut tree, mut parents, mut headers) = (String::new(), Vec::new(), Vec::new());
        let mut skipping = false;
        for line in head.lines().filter(|l| !l.is_empty()) {
            // A continuation line belongs to the header above it.
            if let Some(more) = line.strip_prefix(' ') {
                if !skipping {
                    if let Some(last) = headers.last_mut() {
                        let last: &mut String = last;
                        last.push_str("\n ");
                        last.push_str(more);
                    }
                }
                continue;
            }
            skipping = false;
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "tree" => tree = value.to_owned(),
                "parent" => parents.push(value.to_owned()),
                "committer" => {}
                "gpgsig" | "gpgsig-sha256" => skipping = true,
                _ => headers.push(line.to_owned()),
            }
        }
        if tree.is_empty() {
            return Err(GitError::Parse { command: "cat-file commit".into(), detail: oid.to_owned() });
        }
        Ok(Self { tree, parents, headers, message })
    }

    fn write(&self, git: &Git, root: &Path, tree: &str, parents: &[String], committer: &str, message: &[u8]) -> Result<String, GitError> {
        let mut text = format!("tree {tree}\n");
        for parent in parents {
            text.push_str(&format!("parent {parent}\n"));
        }
        // The author first, then the committer, then the rest, as git writes them.
        let (author, others): (Vec<&String>, Vec<&String>) = self.headers.iter().partition(|h| h.starts_with("author "));
        for header in author {
            text.push_str(header);
            text.push('\n');
        }
        text.push_str(&format!("committer {committer}\n"));
        for header in others {
            text.push_str(header);
            text.push('\n');
        }
        text.push('\n');
        let mut bytes = text.into_bytes();
        bytes.extend_from_slice(message);
        let oid = git.output_with_input(root, &["hash-object", "-t", "commit", "-w", "--stdin"], &bytes)?;
        Ok(String::from_utf8_lossy(&oid).trim().to_owned())
    }
}

/// Commits between `oid` (excluded) and HEAD that descend from it, parents before children.
fn descendants(git: &Git, root: &Path, oid: &str) -> Result<Vec<String>, GitError> {
    let text = git.text(root, ["rev-list", "--reverse", "--topo-order", "--ancestry-path", &format!("{oid}..HEAD")])?;
    Ok(text.lines().map(str::to_owned).collect())
}

fn is_ancestor_of_head(git: &Git, root: &Path, oid: &str) -> Result<bool, GitError> {
    let out = git.raw(root, &["merge-base", "--is-ancestor", oid, "HEAD"])?;
    Ok(out.status.success())
}

fn operation(git: &Git, root: &Path) -> Result<Option<Operation>, GitError> {
    let dir = git.text(root, ["rev-parse", "--absolute-git-dir"])?;
    Ok(Operation::detect(Path::new(dir.trim())))
}

fn short(oid: &str) -> String {
    oid.chars().take(7).collect()
}

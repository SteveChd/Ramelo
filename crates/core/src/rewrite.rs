//! Rewriting the history of the current branch without an interactive rebase: changing the message
//! of a past commit or the content of one of its files, or combining a commit with the one before it,
//! or several commits that follow one another into one (squash, fixup), or moving a commit one place
//! up or down (swapping it with its neighbour).
//!
//! A move applies the change of each of the two commits on top of the other with `git merge-tree`,
//! in memory: the working copy is only touched at the end.
//!
//! The commit and every commit after it up to HEAD are written again as new objects (same author,
//! same messages, the user as committer), then HEAD moves to the new tip with `reset --keep`, which
//! updates the working copy and refuses to overwrite local changes. Nothing changes until that last
//! step: a conflict or an error leaves the repository as it was, and the old commits stay in the
//! reflog.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

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
    /// How it can be combined with the commit before it; `None` when it cannot (a merge, the first
    /// commit, or another line leaves from the commit before it).
    pub squash: Option<SquashInfo>,
}

/// The commit a squash or a fixup would combine the selected one with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquashInfo {
    pub parent: String,
    /// Remote branches that already contain the parent: they will need a force push.
    pub pushed_to: Vec<String>,
}

pub fn rewrite_info(git: &Git, root: &Path, oid: &str) -> Result<RewriteInfo, GitError> {
    let editable = operation(git, root)?.is_none() && is_ancestor_of_head(git, root, oid)?;
    let descendants = if editable { descendants(git, root, oid)?.len() } else { 0 };
    let squash = match editable.then(|| squash_parent(git, root, oid)).transpose()?.flatten() {
        Some(parent) => Some(SquashInfo { pushed_to: pushed_to(git, root, &parent)?, parent }),
        None => None,
    };
    Ok(RewriteInfo { editable, descendants, pushed_to: pushed_to(git, root, oid)?, squash })
}

fn pushed_to(git: &Git, root: &Path, oid: &str) -> Result<Vec<String>, GitError> {
    Ok(git
        .text(root, ["for-each-ref", "--contains", oid, "--format=%(refname:short)", "refs/remotes"])?
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.ends_with("/HEAD"))
        .map(str::to_owned)
        .collect())
}

/// The parent `oid` can be combined with: its only parent, when every commit after that parent up to
/// HEAD comes through `oid` (otherwise another line would lose its base).
fn squash_parent(git: &Git, root: &Path, oid: &str) -> Result<Option<String>, GitError> {
    let commit = RawCommit::read(git, root, oid)?;
    let [parent] = commit.parents.as_slice() else {
        return Ok(None);
    };
    let linear = descendants(git, root, parent)?.len() == descendants(git, root, oid)?.len() + 1;
    Ok(linear.then(|| parent.clone()))
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

/// Combines commit `oid` with the commit before it: one commit with both changes, the parent's
/// author and `message` (squash), or the parent's message when `message` is `None` (fixup).
pub fn squash(git: &Git, root: &Path, oid: &str, message: Option<&str>) -> Result<Rewritten, GitError> {
    let oid = check(git, root, oid)?;
    let parent = squash_parent(git, root, &oid)?.ok_or_else(|| GitError::CannotSquash(short(&oid)))?;
    rewrite(git, root, &parent, Change::Squash { absorbed: vec![oid], message: squash_message(message)? })
}

fn squash_message(message: Option<&str>) -> Result<Option<String>, GitError> {
    match message.map(str::trim_end) {
        Some(m) if m.trim().is_empty() => Err(GitError::NothingToCommit),
        Some(m) => Ok(Some(format!("{m}\n"))),
        None => Ok(None),
    }
}

/// Combines commits that follow one another on the current branch into one, given in any order: the
/// oldest takes the changes of all of them, its author, and `message` (squash), or keeps its own
/// message when `message` is `None` (fixup). Each commit but the oldest must have the one before it
/// as its only parent, with no other line leaving from it.
pub fn squash_many(git: &Git, root: &Path, oids: &[String], message: Option<&str>) -> Result<Rewritten, GitError> {
    let mut chain = Vec::with_capacity(oids.len());
    for oid in oids {
        let oid = check(git, root, oid)?;
        if !chain.contains(&oid) {
            chain.push(oid);
        }
    }
    let [first, ..] = chain.as_slice() else {
        return Err(GitError::NothingToCommit);
    };
    if chain.len() == 1 {
        return squash(git, root, &first.clone(), message);
    }
    // The oldest has the most commits after it.
    let mut counted = Vec::with_capacity(chain.len());
    for oid in chain {
        counted.push((descendants(git, root, &oid)?.len(), oid));
    }
    counted.sort_by_key(|c| std::cmp::Reverse(c.0));
    let chain: Vec<String> = counted.into_iter().map(|(_, oid)| oid).collect();
    for pair in chain.windows(2) {
        if squash_parent(git, root, &pair[1])?.as_deref() != Some(pair[0].as_str()) {
            return Err(GitError::CannotSquash(short(&pair[1])));
        }
    }
    let message = squash_message(message)?;
    rewrite(git, root, &chain[0], Change::Squash { absorbed: chain[1..].to_vec(), message })
}

/// Which way a commit moves: up (after the commit that follows it) or down (before the one before it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Up,
    Down,
}

/// Moves commit `oid` one place up or down on the current branch: it swaps with its neighbour, each
/// change applied on top of the other. Both must follow one another without a merge, and the lower
/// one must have a parent. A conflict between their changes leaves the history as it was.
pub fn move_commit(git: &Git, root: &Path, oid: &str, direction: Direction) -> Result<Rewritten, GitError> {
    let oid = check(git, root, oid)?;
    let cannot = || GitError::CannotMove(short(&oid));
    let (lower, upper) = match direction {
        Direction::Down => (squash_parent(git, root, &oid)?.ok_or_else(cannot)?, oid.clone()),
        Direction::Up => (oid.clone(), only_child(git, root, &oid)?.ok_or_else(cannot)?),
    };
    let low = RawCommit::read(git, root, &lower)?;
    let up = RawCommit::read(git, root, &upper)?;
    let [base] = low.parents.as_slice() else {
        return Err(cannot());
    };
    let head = git.text(root, ["rev-parse", "HEAD"])?.trim().to_owned();
    let committer = git.text(root, ["var", "GIT_COMMITTER_IDENT"]).map_err(|_| GitError::IdentityMissing)?.trim().to_owned();

    // The upper change first, on the base; then the lower one on top of it.
    let up_tree = pick(git, root, &lower, base, &upper)?;
    let new_up = up.write(git, root, &up_tree, std::slice::from_ref(base), &committer, &up.message)?;
    let low_tree = pick(git, root, base, &new_up, &lower)?;
    let new_low = low.write(git, root, &low_tree, std::slice::from_ref(&new_up), &committer, &low.message)?;

    // The commits after them: the same content when the two together give the same result (the
    // usual case), otherwise their own change applied again.
    let mut rewritten: HashMap<String, String> = HashMap::from([(upper.clone(), new_low.clone()), (lower.clone(), new_up.clone())]);
    for old in descendants(git, root, &upper)? {
        let commit = RawCommit::read(git, root, &old)?;
        let parents: Vec<String> = commit.parents.iter().map(|p| rewritten.get(p).cloned().unwrap_or_else(|| p.clone())).collect();
        let tree = if low_tree == up.tree {
            commit.tree.clone()
        } else {
            let ([old_parent], [new_parent]) = (commit.parents.as_slice(), parents.as_slice()) else {
                return Err(GitError::MoveConflict(short(&old)));
            };
            pick(git, root, old_parent, new_parent, &old)?
        };
        let new = commit.write(git, root, &tree, &parents, &committer, &commit.message)?;
        rewritten.insert(old, new);
    }
    let new_head = rewritten.get(&head).cloned().unwrap_or(head);
    move_head(git, root, &new_head)?;
    Ok(Rewritten { head: new_head, commit: if oid == upper { new_up } else { new_low } })
}

/// The commit whose only parent is `oid`, on the way to HEAD, with no other line leaving from `oid`.
fn only_child(git: &Git, root: &Path, oid: &str) -> Result<Option<String>, GitError> {
    for later in descendants(git, root, oid)? {
        if RawCommit::read(git, root, &later)?.parents == [oid] {
            return Ok((squash_parent(git, root, &later)?.as_deref() == Some(oid)).then_some(later));
        }
    }
    Ok(None)
}

/// The tree of `onto` with the change from `from` to `commit` applied, as a cherry-pick would give,
/// computed in memory with `git merge-tree` (git 2.40 and later), or by applying the patch to an
/// index of its own with an older git.
fn pick(git: &Git, root: &Path, from: &str, onto: &str, commit: &str) -> Result<String, GitError> {
    let base = format!("--merge-base={from}");
    let out = git.raw(root, &["merge-tree", "--write-tree", "--name-only", "--no-messages", &base, onto, commit])?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let mut lines = text.lines();
    let tree = lines.next().unwrap_or_default().trim().to_owned();
    match out.status.code() {
        Some(0) if !tree.is_empty() => Ok(tree),
        // Status 1: the changes conflict; the conflicted files follow the tree.
        Some(1) => Err(GitError::MoveConflict(lines.map(str::trim).find(|l| !l.is_empty()).unwrap_or_default().to_owned())),
        // The options are not known: an older git.
        _ => pick_by_patch(git, root, from, onto, commit),
    }
}

/// [`pick`] for an older git: the patch from `from` to `commit` applied to `onto` in a temporary
/// index, which leaves the user's index alone.
fn pick_by_patch(git: &Git, root: &Path, from: &str, onto: &str, commit: &str) -> Result<String, GitError> {
    static INDEXES: AtomicU64 = AtomicU64::new(0);
    let dir = git.text(root, ["rev-parse", "--absolute-git-dir"])?;
    let index = Path::new(dir.trim()).join(format!("ramelo-pick-{}-{}", std::process::id(), INDEXES.fetch_add(1, Ordering::Relaxed)));
    let env = [("GIT_INDEX_FILE", index.as_os_str())];
    let run = |args: &[&str], input: Option<&[u8]>| -> Result<std::process::Output, GitError> { git.raw_with_env(root, args, &env, input) };
    let result = (|| {
        Git::check(&["read-tree"], run(&["read-tree", onto], None)?)?;
        let patch = git.output(root, ["diff", "--binary", "--full-index", "--no-renames", from, commit])?;
        if !patch.is_empty() {
            let out = run(&["apply", "--cached", "--3way", "--whitespace=nowarn"], Some(&patch))?;
            if !out.status.success() {
                // « U path » names a conflicted file, « error: patch failed: path:line » one that
                // could not be applied at all.
                let message = String::from_utf8_lossy(&out.stderr);
                let file = message.lines().find_map(|l| {
                    l.strip_prefix("U ").map(str::to_owned).or_else(|| l.split_once("patch failed: ").map(|(_, rest)| rest.rsplit_once(':').map_or(rest, |(f, _)| f).to_owned()))
                });
                return Err(GitError::MoveConflict(file.unwrap_or_default()));
            }
        }
        let tree = Git::check(&["write-tree"], run(&["write-tree"], None)?)?;
        Ok(String::from_utf8_lossy(&tree).trim().to_owned())
    })();
    let _ = fs::remove_file(&index);
    result
}

/// HEAD moves to the rewritten tip; the working copy follows, its own changes kept.
fn move_head(git: &Git, root: &Path, new_head: &str) -> Result<(), GitError> {
    let out = git.raw(root, &["reset", "--quiet", "--keep", new_head])?;
    if !out.status.success() {
        let message = String::from_utf8_lossy(&out.stderr);
        let file = message.lines().find_map(|l| l.split('\'').nth(1)).unwrap_or_default().to_owned();
        return Err(GitError::LocalChanges(file));
    }
    Ok(())
}

enum Change {
    Message(String),
    File { path: String, content: Vec<u8> },
    /// The rewritten commit takes the tree of the last of `absorbed` (commits that follow it one
    /// after the other), which disappear.
    Squash { absorbed: Vec<String>, message: Option<String> },
}

/// The full id of `oid`, once checked that it can be rewritten.
fn check(git: &Git, root: &Path, oid: &str) -> Result<String, GitError> {
    if operation(git, root)?.is_some() {
        return Err(GitError::OperationInProgress);
    }
    let oid = git.text(root, ["rev-parse", "--verify", &format!("{oid}^{{commit}}")])?.trim().to_owned();
    if !is_ancestor_of_head(git, root, &oid)? {
        return Err(GitError::NotInHistory(short(&oid)));
    }
    Ok(oid)
}

fn rewrite(git: &Git, root: &Path, oid: &str, change: Change) -> Result<Rewritten, GitError> {
    let oid = check(git, root, oid)?;
    let head = git.text(root, ["rev-parse", "HEAD"])?.trim().to_owned();
    let committer = git.text(root, ["var", "GIT_COMMITTER_IDENT"]).map_err(|_| GitError::IdentityMissing)?.trim().to_owned();

    // Old commit → new commit, for the parents of the commits written after it.
    let mut rewritten: HashMap<String, String> = HashMap::new();
    let mut order = vec![oid.clone()];
    order.extend(descendants(git, root, &oid)?);
    for old in &order {
        // The squashed commit is now part of the one before it.
        if let Change::Squash { absorbed, .. } = &change {
            if absorbed.contains(old) {
                let merged = rewritten[&oid].clone();
                rewritten.insert(old.clone(), merged);
                continue;
            }
        }
        let commit = RawCommit::read(git, root, old)?;
        let parents: Vec<String> = commit.parents.iter().map(|p| rewritten.get(p).cloned().unwrap_or_else(|| p.clone())).collect();
        let (tree, message) = match &change {
            Change::Squash { absorbed, message } if *old == oid => {
                let last = absorbed.last().ok_or(GitError::NothingToCommit)?;
                let tree = git.text(root, ["rev-parse", &format!("{last}^{{tree}}")])?.trim().to_owned();
                (tree, message.as_ref().map_or_else(|| commit.message.clone(), |m| m.as_bytes().to_vec()))
            }
            Change::Squash { .. } => (commit.tree.clone(), commit.message.clone()),
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
        if *old == oid && tree == commit.tree && message == commit.message && !matches!(change, Change::Squash { .. }) {
            return Ok(Rewritten { head, commit: oid });
        }
        let new = commit.write(git, root, &tree, &parents, &committer, &message)?;
        rewritten.insert(old.clone(), new);
    }

    let new_head = rewritten.get(&head).cloned().unwrap_or(head);
    let commit = rewritten.get(&oid).cloned().unwrap_or(oid);
    move_head(git, root, &new_head)?;
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
    let dir = std::env::temp_dir().join(format!("ramelo-merge-{}-{}", std::process::id(), short(ours)));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn run(root: &Path, args: &[&str]) -> String {
        Git::default().text(root, args.iter().copied()).unwrap().trim().to_owned()
    }

    fn commit(root: &Path, file: &str, content: &str, message: &str) -> String {
        fs::write(root.join(file), content).unwrap();
        run(root, &["add", file]);
        run(root, &["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "-m", message]);
        run(root, &["rev-parse", "HEAD"])
    }

    /// The way of an older git gives the same trees as `merge-tree`, and the same conflicts.
    #[test]
    fn picks_by_patch_like_merge_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q", "-b", "main"]);
        let base = commit(root, "a.txt", "1\n2\n3\n", "Base");
        let one = commit(root, "a.txt", "one\n2\n3\n", "One");
        let two = commit(root, "a.txt", "one\n2\nthree\n", "Two");
        let git = Git::default();
        // « Two » on « Base », as if « One » came after it.
        let by_patch = pick_by_patch(&git, root, &one, &base, &two).unwrap();
        assert_eq!(by_patch, pick(&git, root, &one, &base, &two).unwrap());
        assert_eq!(run(root, &["cat-file", "-p", &format!("{by_patch}:a.txt")]), "1\n2\nthree");
        let index = run(root, &["rev-parse", "--absolute-git-dir"]);
        assert!(fs::read_dir(index).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with("ramelo-pick")));

        let again = commit(root, "a.txt", "ONE\n2\nthree\n", "Again");
        // « Again » changes the first line, which is not the same on « Base »: a conflict either way.
        assert!(matches!(pick_by_patch(&git, root, &two, &base, &again), Err(GitError::MoveConflict(f)) if f == "a.txt"));
        assert!(matches!(pick(&git, root, &two, &base, &again), Err(GitError::MoveConflict(f)) if f == "a.txt"));
    }
}

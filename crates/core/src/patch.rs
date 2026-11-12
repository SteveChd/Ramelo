//! Commits as patches: the text `git format-patch` writes for each of them (author, date, message and
//! changes, binary files included), which `git am` applies in another repository; and the other way:
//! applying such files here, or a plain diff, into the working copy.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::repo::Operation;
use crate::status::{parse_status, STATUS_ARGS};
use crate::{Git, GitError};

/// The patches of some commits, one after the other in a single text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSet {
    pub text: String,
    /// Commits written into it.
    pub count: usize,
    /// Merge commits left out: a merge has no single change to write as a patch.
    pub merges: Vec<String>,
}

/// The patches of `oids`, in the order given (the oldest first, so that `git am` applies them in
/// that order).
pub fn format_patches(git: &Git, root: &Path, oids: &[String]) -> Result<PatchSet, GitError> {
    let mut text = String::new();
    let mut count = 0;
    let mut merges = Vec::new();
    for oid in oids {
        let parents = git.text(root, ["rev-list", "--parents", "-n", "1", oid.as_str(), "--"])?;
        if parents.split_whitespace().count() > 2 {
            merges.push(oid.clone());
            continue;
        }
        let patch = git.text(root, ["format-patch", "-1", "--stdout", oid.as_str(), "--"])?;
        if patch.is_empty() {
            continue;
        }
        text.push_str(&patch);
        count += 1;
    }
    Ok(PatchSet { text, count, merges })
}

/// The file name git would give the patch of a commit with this summary: « 0001- » then the summary
/// in lower case, its words joined by dashes, cut at 52 characters.
pub fn patch_file_name(summary: &str) -> String {
    let mut slug = String::new();
    for c in summary.chars() {
        if c.is_alphanumeric() {
            slug.extend(c.to_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug: String = slug.chars().take(52).collect();
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() { "0001.patch".to_owned() } else { format!("0001-{slug}.patch") }
}

/// What applying patch files did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Applied {
    /// Patches of commits (`format-patch`): each became a commit of the current branch.
    Commits { count: usize },
    /// Plain diffs: their changes are in the working copy, staged, to commit.
    Changes { files: usize },
    /// Stopped on conflicts, to resolve then continue (or abort): a `git am` in progress, or files of
    /// the working copy left in conflict by a plain diff.
    Conflicts,
}

/// Whether `text` was written by `git format-patch` (a mailbox of commits) rather than `git diff`.
fn is_mailbox(text: &str) -> bool {
    text.starts_with("From ") && text.contains("\nSubject:")
}

/// Commits in a mailbox: each starts with « From <40 hex> ».
fn mailbox_commits(text: &str) -> usize {
    text.lines()
        .filter(|l| l.strip_prefix("From ").and_then(|r| r.split_whitespace().next()).is_some_and(|oid| oid.len() >= 40 && oid.chars().all(|c| c.is_ascii_hexdigit())))
        .count()
}

/// Applies `files` in the order given. Patches of commits are applied with `git am --3way`, which
/// makes a commit of each one and stops on conflicts like a rebase; plain diffs go into the working
/// copy with `git apply --3way`. A file that does not apply at all leaves the repository as it was.
pub fn apply_patches(git: &Git, root: &Path, files: &[PathBuf]) -> Result<Applied, GitError> {
    let dir = git.text(root, ["rev-parse", "--absolute-git-dir"])?;
    let git_dir = PathBuf::from(dir.trim());
    if Operation::detect(&git_dir).is_some() {
        return Err(GitError::OperationInProgress);
    }
    let mut texts = Vec::new();
    for file in files {
        let text = fs::read(file).map_err(|source| GitError::Io { path: file.clone(), source })?;
        texts.push(String::from_utf8_lossy(&text).into_owned());
    }
    let mailboxes: Vec<&PathBuf> = files.iter().zip(&texts).filter(|(_, t)| is_mailbox(t)).map(|(f, _)| f).collect();
    if mailboxes.len() == files.len() {
        let count = texts.iter().map(|t| mailbox_commits(t)).sum();
        let mut args: Vec<String> = vec!["am".into(), "--3way".into(), "--keep-cr".into()];
        args.extend(files.iter().map(|f| f.display().to_string()));
        let out = git.raw(root, &args)?;
        if out.status.success() {
            return Ok(Applied::Commits { count });
        }
        if Operation::detect(&git_dir) == Some(Operation::Am) {
            if parse_status(&git.output(root, STATUS_ARGS)?)?.conflicted() > 0 {
                return Ok(Applied::Conflicts);
            }
            // Stopped without any conflict to resolve (the patch does not apply at all): nothing to
            // continue from, so nothing is left half done.
            let _ = git.raw(root, &["am", "--abort"]);
        }
        let text = format!("{}{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
        return Err(crate::error::classify("am".into(), text.trim().to_owned(), &text));
    }
    if !mailboxes.is_empty() {
        return Err(GitError::Failed {
            command: "apply".into(),
            message: "patches of commits and plain diffs cannot be applied together".into(),
        });
    }
    let mut files_changed = 0;
    for (file, text) in files.iter().zip(&texts) {
        let file_arg = file.display().to_string();
        let out = git.raw(root, &["apply", "--3way", "--whitespace=nowarn", file_arg.as_str()])?;
        if !out.status.success() {
            if parse_status(&git.output(root, STATUS_ARGS)?)?.conflicted() > 0 {
                return Ok(Applied::Conflicts);
            }
            let text = format!("{}{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
            return Err(crate::error::classify("apply".into(), text.trim().to_owned(), &text));
        }
        files_changed += text.lines().filter(|l| l.starts_with("diff --git ")).count();
    }
    Ok(Applied::Changes { files: files_changed })
}

#[cfg(test)]
mod tests {
    use std::fs;

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

    #[test]
    fn writes_patches_that_apply_elsewhere() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("a");
        fs::create_dir(&root).unwrap();
        run(&root, &["init", "-q", "-b", "main"]);
        commit(&root, "a.txt", "1\n", "Base");
        let one = commit(&root, "a.txt", "1\n2\n", "Add two");
        let two = commit(&root, "b.txt", "b\n", "Add b");

        let git = Git::default();
        let set = format_patches(&git, &root, &[one.clone(), two.clone()]).unwrap();
        assert_eq!(set.count, 2);
        assert!(set.merges.is_empty());
        assert!(set.text.find("Subject: [PATCH] Add two").unwrap() < set.text.find("Subject: [PATCH] Add b").unwrap());

        // Another clone at « Base » takes both commits with `git am`.
        let other = dir.path().join("b");
        run(dir.path(), &["clone", "-q", root.to_str().unwrap(), "b"]);
        run(&other, &["reset", "-q", "--hard", "HEAD~2"]);
        let file = dir.path().join("set.patch");
        fs::write(&file, &set.text).unwrap();
        run(&other, &["-c", "user.name=T", "-c", "user.email=t@e", "am", "-q", file.to_str().unwrap()]);
        assert_eq!(run(&other, &["log", "--format=%s", "-2"]), "Add b\nAdd two");
        assert_eq!(fs::read_to_string(other.join("a.txt")).unwrap(), "1\n2\n");
    }

    #[test]
    fn leaves_merges_out() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q", "-b", "main"]);
        commit(root, "a.txt", "1\n", "Base");
        run(root, &["checkout", "-q", "-b", "side"]);
        let side = commit(root, "b.txt", "b\n", "Side");
        run(root, &["checkout", "-q", "main"]);
        commit(root, "c.txt", "c\n", "Main");
        run(root, &["-c", "user.name=T", "-c", "user.email=t@e", "merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
        let merge = run(root, &["rev-parse", "HEAD"]);
        let set = format_patches(&Git::default(), root, &[side, merge.clone()]).unwrap();
        assert_eq!(set.count, 1);
        assert_eq!(set.merges, vec![merge]);
    }

    fn exported(dir: &Path) -> (PathBuf, PathBuf, String) {
        let root = dir.join("a");
        fs::create_dir(&root).unwrap();
        run(&root, &["init", "-q", "-b", "main"]);
        commit(&root, "a.txt", "1\n2\n3\n", "Base");
        let one = commit(&root, "a.txt", "one\n2\n3\n", "First line");
        let other = dir.join("b");
        run(dir, &["clone", "-q", root.to_str().unwrap(), "b"]);
        run(&other, &["reset", "-q", "--hard", "HEAD~1"]);
        run(&other, &["config", "user.name", "T"]);
        run(&other, &["config", "user.email", "t@e"]);
        let file = dir.join("one.patch");
        fs::write(&file, format_patches(&Git::default(), &root, &[one]).unwrap().text).unwrap();
        (other, file, "one\n2\n3\n".to_owned())
    }

    #[test]
    fn applies_patches_of_commits() {
        let dir = tempfile::tempdir().unwrap();
        let (other, file, expected) = exported(dir.path());
        let applied = apply_patches(&Git::default(), &other, &[file]).unwrap();
        assert_eq!(applied, Applied::Commits { count: 1 });
        assert_eq!(run(&other, &["log", "-1", "--format=%s"]), "First line");
        assert_eq!(fs::read_to_string(other.join("a.txt")).unwrap(), expected);
    }

    #[test]
    fn stops_on_conflicts_like_a_rebase() {
        let dir = tempfile::tempdir().unwrap();
        let (other, file, _) = exported(dir.path());
        commit(&other, "a.txt", "ONE\n2\n3\n", "Same line here");
        let applied = apply_patches(&Git::default(), &other, std::slice::from_ref(&file)).unwrap();
        assert_eq!(applied, Applied::Conflicts);
        let dir_git = run(&other, &["rev-parse", "--absolute-git-dir"]);
        assert_eq!(Operation::detect(Path::new(&dir_git)), Some(Operation::Am));
        // Resolved, then continued like any other operation.
        fs::write(other.join("a.txt"), "one\n2\n3\n").unwrap();
        run(&other, &["add", "a.txt"]);
        assert_eq!(crate::continue_operation(&Git::default(), &other).unwrap(), crate::Progress::Done);
        assert_eq!(run(&other, &["log", "-1", "--format=%s"]), "First line");
        // Another one cannot start while one is in progress.
        commit(&other, "a.txt", "x\n2\n3\n", "Again");
        assert_eq!(apply_patches(&Git::default(), &other, std::slice::from_ref(&file)).unwrap(), Applied::Conflicts);
        assert!(matches!(apply_patches(&Git::default(), &other, &[file]), Err(GitError::OperationInProgress)));
    }

    #[test]
    fn a_patch_that_does_not_apply_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let (other, _, _) = exported(dir.path());
        let file = dir.path().join("bad.patch");
        fs::write(&file, "From 0123456789012345678901234567890123456789 Mon Sep 17 00:00:00 2001\nFrom: T <t@e>\nSubject: [PATCH] Missing\n\n---\ndiff --git a/none.txt b/none.txt\nindex 1111111..2222222 100644\n--- a/none.txt\n+++ b/none.txt\n@@ -1 +1 @@\n-a\n+b\n").unwrap();
        assert!(apply_patches(&Git::default(), &other, &[file]).is_err());
        let dir_git = run(&other, &["rev-parse", "--absolute-git-dir"]);
        assert_eq!(Operation::detect(Path::new(&dir_git)), None);
    }

    #[test]
    fn applies_a_plain_diff_to_the_working_copy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q", "-b", "main"]);
        commit(root, "a.txt", "1\n2\n", "Base");
        fs::write(root.join("a.txt"), "1\ntwo\n").unwrap();
        let diff = run(root, &["diff"]) + "\n";
        run(root, &["checkout", "--", "a.txt"]);
        let file = root.join("../plain.diff");
        fs::write(&file, diff).unwrap();
        assert_eq!(apply_patches(&Git::default(), root, &[file]).unwrap(), Applied::Changes { files: 1 });
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "1\ntwo\n");
        assert_eq!(run(root, &["log", "--format=%s"]), "Base");
    }

    #[test]
    fn names_the_file_like_git() {
        assert_eq!(patch_file_name("Fix the week numbers around New Year"), "0001-fix-the-week-numbers-around-new-year.patch");
        assert_eq!(patch_file_name("feat(ui): add «patch» export!"), "0001-feat-ui-add-patch-export.patch");
        assert_eq!(patch_file_name("…"), "0001.patch");
    }
}

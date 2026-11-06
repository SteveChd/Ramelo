//! Commits as patches: the text `git format-patch` writes for each of them (author, date, message and
//! changes, binary files included), which `git am` applies in another repository.

use std::path::Path;

use serde::Serialize;

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

    #[test]
    fn names_the_file_like_git() {
        assert_eq!(patch_file_name("Fix the week numbers around New Year"), "0001-fix-the-week-numbers-around-new-year.patch");
        assert_eq!(patch_file_name("feat(ui): add «patch» export!"), "0001-feat-ui-add-patch-export.patch");
        assert_eq!(patch_file_name("…"), "0001.patch");
    }
}

//! Reads real repositories created with the git command line.

use std::fs;
use std::path::Path;

use ramelo_core::{open, summary, ChangeKind, Git, GitError, Operation};

fn git(dir: &Path, args: &[&str]) {
    let out = Git::default().raw(dir, args).unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn new_repo(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
}

#[test]
fn summarizes_a_repository_from_any_of_its_folders() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("my repo");
    fs::create_dir_all(root.join("src/deep")).unwrap();
    new_repo(&root);

    let git_ = Git::default();
    let location = open(&git_, &root.join("src/deep")).unwrap();
    assert_eq!(location.root, dunce::canonicalize(&root).unwrap());
    assert_eq!(location.name(), "my repo");

    // A new repository: no commit yet.
    let fresh = summary(&git_, &location).unwrap();
    assert!(fresh.status.head.is_unborn());
    assert_eq!(fresh.status.head.branch.as_deref(), Some("main"));
    assert_eq!(fresh.last_commit, None);

    fs::write(root.join("a.txt"), "one").unwrap();
    git(&root, &["add", "a.txt"]);
    git(&root, &["commit", "-q", "-m", "First commit"]);
    fs::write(root.join("a.txt"), "two").unwrap();
    fs::write(root.join("src/deep/new file.rs"), "").unwrap();

    let state = summary(&git_, &location).unwrap();
    let commit = state.last_commit.unwrap();
    assert_eq!((commit.summary.as_str(), commit.author.as_str()), ("First commit", "Test"));
    let files: Vec<_> = state.status.files.iter().map(|f| (f.path.as_str(), f.worktree)).collect();
    assert_eq!(files, [("a.txt", ChangeKind::Modified), ("src/deep/new file.rs", ChangeKind::Untracked)]);
    assert_eq!(state.operation, None);
    assert!(state.remotes.is_empty());
}

#[test]
fn counts_commits_ahead_and_behind_the_upstream() {
    let dir = tempfile::tempdir().unwrap();
    let origin = dir.path().join("origin");
    fs::create_dir_all(&origin).unwrap();
    new_repo(&origin);
    fs::write(origin.join("f"), "1").unwrap();
    git(&origin, &["add", "."]);
    git(&origin, &["commit", "-q", "-m", "c1"]);

    let clone = dir.path().join("clone");
    git(dir.path(), &["clone", "-q", origin.to_str().unwrap(), clone.to_str().unwrap()]);
    git(&clone, &["config", "user.name", "Test"]);
    git(&clone, &["config", "user.email", "test@example.com"]);
    git(&clone, &["commit", "-q", "--allow-empty", "-m", "local"]);
    git(&origin, &["commit", "-q", "--allow-empty", "-m", "remote 1"]);
    git(&origin, &["commit", "-q", "--allow-empty", "-m", "remote 2"]);
    git(&clone, &["fetch", "-q"]);

    let git_ = Git::default();
    let state = summary(&git_, &open(&git_, &clone).unwrap()).unwrap();
    assert_eq!(state.status.upstream.as_deref(), Some("origin/main"));
    assert_eq!((state.status.ahead, state.status.behind), (1, 2));
    assert_eq!(state.remotes, ["origin"]);
}

#[test]
fn detects_a_merge_left_in_progress() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    new_repo(root);
    fs::write(root.join("f"), "base").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    git(root, &["checkout", "-q", "-b", "other"]);
    fs::write(root.join("f"), "other").unwrap();
    git(root, &["commit", "-q", "-am", "other"]);
    git(root, &["checkout", "-q", "main"]);
    fs::write(root.join("f"), "main").unwrap();
    git(root, &["commit", "-q", "-am", "main"]);
    let merge = Git::default().raw(root, &["merge", "other"]).unwrap();
    assert!(!merge.status.success());

    let git_ = Git::default();
    let state = summary(&git_, &open(&git_, root).unwrap()).unwrap();
    assert_eq!(state.operation, Some(Operation::Merge));
    assert_eq!(state.status.conflicted(), 1);
}

#[test]
fn refuses_a_folder_outside_any_repository() {
    let dir = tempfile::tempdir().unwrap();
    let git_ = Git::default();
    assert!(matches!(open(&git_, dir.path()), Err(GitError::NotARepository(_))));
    assert!(matches!(open(&git_, &dir.path().join("missing")), Err(GitError::PathMissing(_))));
}

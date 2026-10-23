//! Changes made through the core on real repositories: staging, commits, branches, pull and push.

use std::fs;
use std::path::{Path, PathBuf};

use gitcontroller_core::*;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Git::default().raw(dir, args).unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn identity(dir: &Path) {
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
}

fn new_repo(dir: &Path) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    identity(dir);
    dir.to_path_buf()
}

fn status(root: &Path) -> RepoStatus {
    let g = Git::default();
    summary(&g, &open(&g, root).unwrap()).unwrap().status
}

fn commit_file(root: &Path, name: &str, content: &str, message: &str) {
    fs::write(root.join(name), content).unwrap();
    git(root, &["add", name]);
    git(root, &["commit", "-q", "-m", message]);
}

#[test]
fn stages_unstages_discards_and_commits() {
    let dir = tempfile::tempdir().unwrap();
    let root = new_repo(&dir.path().join("r"));
    let g = Git::default();

    // Before the first commit, unstaging still works.
    fs::write(root.join("a *.txt"), "one\n").unwrap();
    stage(&g, &root, &["a *.txt".into()]).unwrap();
    assert_eq!(status(&root).staged(), 1);
    unstage(&g, &root, &["a *.txt".into()]).unwrap();
    assert_eq!((status(&root).staged(), status(&root).untracked()), (0, 1));

    assert!(matches!(commit(&g, &root, "Empty", false), Err(GitError::NothingToCommit)));
    stage_all(&g, &root).unwrap();
    let first = commit(&g, &root, "First\n\nWith a body.", false).unwrap();
    assert_eq!(last_message(&g, &root).unwrap().as_deref(), Some("First\n\nWith a body."));

    fs::write(root.join("a *.txt"), "two\n").unwrap();
    fs::write(root.join("junk.tmp"), "x").unwrap();
    discard(&g, &root, &["a *.txt".into()], &["junk.tmp".into()]).unwrap();
    assert!(status(&root).is_clean());
    assert_eq!(fs::read_to_string(root.join("a *.txt")).unwrap(), "one\n");

    fs::write(root.join("b.txt"), "b\n").unwrap();
    stage(&g, &root, &["b.txt".into()]).unwrap();
    let amended = commit(&g, &root, "First, amended", true).unwrap();
    assert_ne!(first, amended);
    assert_eq!(log(&g, &root, 10, 0).unwrap().len(), 1);
    unstage_all(&g, &root).unwrap();
}

#[test]
fn stages_and_discards_single_hunks() {
    let dir = tempfile::tempdir().unwrap();
    let root = new_repo(&dir.path().join("r"));
    let g = Git::default();
    let lines: Vec<String> = (1..=30).map(|i| format!("line {i}")).collect();
    commit_file(&root, "f.txt", &(lines.join("\n") + "\n"), "base");

    let mut changed = lines.clone();
    changed[1] = "line 2 changed".into();
    changed[27] = "line 28 changed".into();
    fs::write(root.join("f.txt"), changed.join("\n") + "\n").unwrap();

    let diff = worktree_diff(&g, &root, "f.txt", false, false).unwrap().unwrap();
    assert_eq!(diff.hunks.len(), 2);
    apply_hunk(&g, &root, &diff.hunk_patch(0).unwrap(), HunkAction::Stage).unwrap();
    let staged = worktree_diff(&g, &root, "f.txt", true, false).unwrap().unwrap();
    assert_eq!(staged.hunks.len(), 1);
    assert!(staged.hunks[0].lines.iter().any(|l| l.text == "line 2 changed"));

    // The other hunk is thrown away; the staged one stays.
    let rest = worktree_diff(&g, &root, "f.txt", false, false).unwrap().unwrap();
    apply_hunk(&g, &root, &rest.hunk_patch(0).unwrap(), HunkAction::Discard).unwrap();
    assert!(worktree_diff(&g, &root, "f.txt", false, false).unwrap().is_none());
    apply_hunk(&g, &root, &staged.hunk_patch(0).unwrap(), HunkAction::Unstage).unwrap();
    assert!(worktree_diff(&g, &root, "f.txt", true, false).unwrap().is_none());

    fs::write(root.join("new file.txt"), "hello\n").unwrap();
    let untracked = worktree_diff(&g, &root, "new file.txt", false, true).unwrap().unwrap();
    assert_eq!((untracked.status, untracked.additions), (FileStatus::Added, 1));
}

#[test]
fn reads_history_graph_and_commit_details() {
    let dir = tempfile::tempdir().unwrap();
    let root = new_repo(&dir.path().join("r"));
    let g = Git::default();
    assert!(log(&g, &root, 10, 0).unwrap().is_empty());
    commit_file(&root, "a", "1\n", "one");
    git(&root, &["switch", "-q", "-c", "topic"]);
    commit_file(&root, "b", "2\n", "two");
    git(&root, &["switch", "-q", "main"]);
    commit_file(&root, "a", "1\n3\n", "three");
    git(&root, &["merge", "-q", "--no-edit", "topic"]);
    git(&root, &["tag", "-a", "v1", "-m", "v1"]);

    let commits = log(&g, &root, 100, 0).unwrap();
    assert_eq!(commits.len(), 4);
    assert_eq!(commits[0].parents.len(), 2);
    assert!(commits[0].refs.iter().any(|r| r.kind == RefKind::Branch && r.name == "main" && r.is_head));
    assert!(commits[0].refs.iter().any(|r| r.kind == RefKind::Tag && r.name == "v1"));
    let (rows, width) = layout(&commits);
    assert_eq!((rows.len(), width), (4, 2));

    let details = commit_details(&g, &root, &commits[0].oid).unwrap();
    assert_eq!(details.parents.len(), 2);
    assert_eq!(details.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["b"]);
    assert_eq!(log(&g, &root, 2, 3).unwrap().len(), 1);

    let refs = refs::list(&g, &root).unwrap();
    assert_eq!(refs.local.iter().map(|b| (b.name.as_str(), b.is_head)).collect::<Vec<_>>().len(), 2);
    assert_eq!(refs.tags[0].oid, commits[0].oid);
}

#[test]
fn switches_branches_carrying_local_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = new_repo(&dir.path().join("r"));
    let g = Git::default();
    commit_file(&root, "a", "base\n", "base");
    assert!(matches!(refs::create(&g, &root, "bad..name", None, false), Err(GitError::InvalidBranchName(_))));
    refs::create(&g, &root, "other", None, false).unwrap();
    git(&root, &["switch", "-q", "other"]);
    commit_file(&root, "a", "other\n", "on other");
    git(&root, &["switch", "-q", "main"]);

    fs::write(root.join("a"), "local\n").unwrap();
    assert!(matches!(refs::switch(&g, &root, "other", false), Err(GitError::LocalChanges(_))));
    assert_eq!(refs::switch(&g, &root, "other", true).unwrap(), Carried::Conflicted);
    assert_eq!(status(&root).head.branch.as_deref(), Some("other"));
    git(&root, &["reset", "-q", "--hard"]);
    fs::write(root.join("new.txt"), "x").unwrap();
    assert_eq!(refs::switch(&g, &root, "main", true).unwrap(), Carried::Reapplied);
    assert!(root.join("new.txt").exists());
    assert!(matches!(refs::delete(&g, &root, "other", false), Err(GitError::BranchNotMerged(name)) if name == "other"));
    refs::delete(&g, &root, "other", true).unwrap();
}

#[test]
fn pushes_with_upstream_and_pulls_with_the_chosen_strategy() {
    let dir = tempfile::tempdir().unwrap();
    let remote = dir.path().join("remote.git");
    git(dir.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    let me = new_repo(&dir.path().join("me"));
    let g = Git::default();
    assert!(matches!(fetch(&g, &me), Err(GitError::NoRemote)));
    git(&me, &["remote", "add", "origin", remote.to_str().unwrap()]);
    commit_file(&me, "a", "1\n", "one");

    // First push: the upstream is set automatically.
    let pushed = push(&g, &me, false).unwrap();
    assert!(pushed.upstream_set);
    assert_eq!(status(&me).upstream.as_deref(), Some("origin/main"));
    assert_eq!(pull(&g, &me, PullMode::Auto).unwrap(), PullOutcome::UpToDate);

    let other = dir.path().join("other");
    git(dir.path(), &["clone", "-q", remote.to_str().unwrap(), other.to_str().unwrap()]);
    identity(&other);
    commit_file(&other, "b", "2\n", "two");
    git(&other, &["push", "-q"]);

    assert_eq!(pull(&g, &me, PullMode::Auto).unwrap(), PullOutcome::FastForwarded { commits: 1 });

    commit_file(&other, "c", "3\n", "three");
    git(&other, &["push", "-q"]);
    commit_file(&me, "d", "4\n", "four");
    assert!(matches!(push(&g, &me, false), Err(GitError::PushRejected(_))));
    assert!(matches!(pull(&g, &me, PullMode::Auto), Err(GitError::Diverged)));
    fs::write(me.join("wip.txt"), "local work").unwrap();
    assert_eq!(pull(&g, &me, PullMode::Rebase).unwrap(), PullOutcome::Rebased { commits: 1 });
    assert!(me.join("wip.txt").exists());
    assert!(!push(&g, &me, false).unwrap().upstream_set);
    fetch(&g, &me).unwrap();
}

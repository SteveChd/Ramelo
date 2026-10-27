//! Changes made through the core on real repositories: staging, commits, branches, pull and push.

use std::fs;
use std::path::{Path, PathBuf};

use ramelo_core::*;

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
fn creates_a_branch_at_an_older_commit_carrying_local_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = new_repo(&dir.path().join("r"));
    let g = Git::default();
    let lines: Vec<String> = (1..=12).map(|i| format!("line {i}\n")).collect();
    commit_file(&root, "a", &lines.concat(), "base");
    let base = git(&root, &["rev-parse", "HEAD"]).trim().to_owned();
    commit_file(&root, "a", &format!("changed\n{}", lines[1..].concat()), "change the top");

    // The file differs between HEAD and the start: a plain « switch --create » would refuse.
    fs::write(root.join("a"), format!("changed\n{}last\n", lines[1..].concat())).unwrap();
    assert_eq!(refs::create(&g, &root, "from-base", Some(&base), true).unwrap(), Carried::Reapplied);
    let s = status(&root);
    assert_eq!(s.head.branch.as_deref(), Some("from-base"));
    assert_eq!(s.head.oid.as_deref(), Some(base.as_str()));
    let content = fs::read_to_string(root.join("a")).unwrap();
    assert!(content.starts_with("line 1\n") && content.ends_with("last\n"));
    assert_eq!(git(&root, &["stash", "list"]), "");

    // A clean working copy switches directly, and without checkout HEAD stays put.
    git(&root, &["reset", "-q", "--hard"]);
    assert_eq!(refs::create(&g, &root, "clean", Some("main"), true).unwrap(), Carried::Nothing);
    assert_eq!(refs::create(&g, &root, "aside", None, false).unwrap(), Carried::Nothing);
    assert_eq!(status(&root).head.branch.as_deref(), Some("clean"));
}

#[test]
fn reads_a_file_in_the_working_copy_the_index_and_commits() {
    let dir = tempfile::tempdir().unwrap();
    let root = new_repo(&dir.path().join("r"));
    let g = Git::default();
    let bytes = |v| file_content(&g, &root, "img.png", v).unwrap().and_then(|c| c.bytes);
    fs::write(root.join("img.png"), [0x89, b'P', b'N', b'G', 0, 1]).unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "first"]);
    fs::write(root.join("img.png"), [0x89, b'P', b'N', b'G', 0, 2]).unwrap();
    git(&root, &["add", "."]);
    fs::write(root.join("img.png"), [0x89, b'P', b'N', b'G', 0, 3]).unwrap();

    assert_eq!(bytes(Version::Revision("HEAD")).unwrap()[5], 1);
    assert_eq!(bytes(Version::Index).unwrap()[5], 2);
    assert_eq!(bytes(Version::Worktree).unwrap()[5], 3);
    // No parent, or no such file: absent.
    assert_eq!(bytes(Version::Revision("HEAD^")), None);
    assert_eq!(file_content(&g, &root, "missing.png", Version::Index).unwrap(), None);
    assert_eq!(file_content(&g, &root, "missing.png", Version::Worktree).unwrap(), None);
    assert_eq!(file_content(&g, &root, "img.png", Version::Worktree).unwrap().unwrap().size, 6);
}

#[test]
fn searches_the_whole_history() {
    let dir = tempfile::tempdir().unwrap();
    let root = new_repo(&dir.path().join("r"));
    let g = Git::default();
    commit_file(&root, "readme.md", "hello\n", "Add the readme");
    git(&root, &["switch", "-q", "-c", "side"]);
    fs::create_dir_all(root.join("src/login")).unwrap();
    commit_file(&root, "src/login/form.rs", "fn check_password() {}\n", "Validate the (password)");
    git(&root, &["switch", "-q", "main"]);
    git(&root, &["-c", "user.name=Alice Martin", "commit", "-q", "--allow-empty", "-m", "Empty commit by Alice"]);

    let find = |text: &str, scope, match_case, regex| {
        let q = SearchQuery { text: text.into(), scope, match_case, regex };
        let found = search(&g, &root, &q, 100).unwrap().oids;
        found.iter().map(|oid| git(&root, &["log", "-1", "--format=%s", oid]).trim().to_owned()).collect::<Vec<_>>()
    };
    // The side branch is searched too, and the text is not a regular expression unless asked.
    assert_eq!(find("(PASSWORD)", SearchScope::Message, false, false), ["Validate the (password)"]);
    assert!(find("(PASSWORD)", SearchScope::Message, true, false).is_empty());
    assert_eq!(find("^add", SearchScope::Message, false, true), ["Add the readme"]);
    assert_eq!(find("alice", SearchScope::Author, false, false), ["Empty commit by Alice"]);
    assert_eq!(find("LOGIN", SearchScope::File, false, false), ["Validate the (password)"]);
    assert_eq!(find("check_password", SearchScope::Code, false, false), ["Validate the (password)"]);
    let readme = git(&root, &["log", "-1", "--format=%h", "main~1"]).trim().to_owned();
    assert_eq!(find(&readme, SearchScope::All, false, false), ["Add the readme"]);
    // Newest first, each commit once.
    assert_eq!(find("a", SearchScope::All, false, false).len(), 3);
    let bad = SearchQuery { text: "(".into(), scope: SearchScope::Message, match_case: false, regex: true };
    assert!(matches!(search(&g, &root, &bad, 10), Err(GitError::InvalidPattern(_))));
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

fn messages(root: &Path) -> Vec<String> {
    git(root, &["log", "--format=%s"]).lines().map(str::to_owned).collect()
}

#[test]
fn rewords_a_past_commit_and_keeps_the_ones_after_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = new_repo(&dir.path().join("r"));
    let g = Git::default();
    commit_file(&root, "a.txt", "one\n", "First");
    commit_file(&root, "a.txt", "two\n", "Secnod");
    let target = git(&root, &["rev-parse", "HEAD"]).trim().to_owned();
    commit_file(&root, "b.txt", "x\n", "Third");
    fs::write(root.join("b.txt"), "local\n").unwrap();

    let info = rewrite_info(&g, &root, &target).unwrap();
    assert!(info.editable && info.pushed_to.is_empty());
    assert_eq!(info.descendants, 1);

    reword(&g, &root, &target, "Second\n\nWith a body.").unwrap();
    assert_eq!(messages(&root), ["Third", "Second", "First"]);
    assert_eq!(git(&root, &["log", "-1", "--skip=1", "--format=%B"]).trim_end(), "Second\n\nWith a body.");
    // Same author, same content, local changes kept.
    assert_eq!(git(&root, &["log", "-1", "--skip=1", "--format=%an"]).trim(), "Test");
    assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "local\n");
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "two\n");

    // A commit outside the history of HEAD cannot be rewritten.
    git(&root, &["checkout", "-q", "--", "b.txt"]);
    let main_tip = git(&root, &["rev-parse", "main"]).trim().to_owned();
    git(&root, &["switch", "-q", "-c", "side", "HEAD~2"]);
    commit_file(&root, "c.txt", "c\n", "Side");
    assert!(matches!(reword(&g, &root, &main_tip, "No"), Err(GitError::NotInHistory(_))));
}

#[test]
fn edits_a_file_in_a_past_commit_and_carries_the_later_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = new_repo(&dir.path().join("r"));
    let g = Git::default();
    fs::create_dir_all(root.join("src")).unwrap();
    commit_file(&root, "src/lib.rs", "a\nb\nc\nd\ne\n", "Add lib");
    let target = git(&root, &["rev-parse", "HEAD"]).trim().to_owned();
    commit_file(&root, "src/lib.rs", "a\nb\nc\nd\nE\n", "Change the end");
    commit_file(&root, "other.txt", "o\n", "Other file");

    edit_file(&g, &root, &target, "src/lib.rs", b"A\nb\nc\nd\ne\n").unwrap();
    assert_eq!(messages(&root), ["Other file", "Change the end", "Add lib"]);
    // The fix is in the old commit, the later change is still on top, the working copy follows.
    assert_eq!(git(&root, &["show", "HEAD~2:src/lib.rs"]), "A\nb\nc\nd\ne\n");
    assert_eq!(fs::read_to_string(root.join("src/lib.rs")).unwrap(), "A\nb\nc\nd\nE\n");
    assert!(status(&root).is_clean());

    // A change that the next commit contradicts stops everything.
    let before = git(&root, &["rev-parse", "HEAD"]);
    let target = git(&root, &["rev-parse", "HEAD~2"]).trim().to_owned();
    let err = edit_file(&g, &root, &target, "src/lib.rs", b"A\nb\nc\nd\nX\n").unwrap_err();
    assert!(matches!(err, GitError::RewriteConflict(ref p) if p == "src/lib.rs"), "{err:?}");
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), before);

    // A pushed commit can still be rewritten; its remote branch is named.
    let remote = dir.path().join("remote.git");
    git(dir.path(), &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&root, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&root, &["push", "-q", "-u", "origin", "main"]);
    let info = rewrite_info(&g, &root, &target).unwrap();
    assert_eq!(info.pushed_to, ["origin/main"]);
}

#[test]
fn rewrites_through_a_merge() {
    let dir = tempfile::tempdir().unwrap();
    let root = new_repo(&dir.path().join("r"));
    let g = Git::default();
    commit_file(&root, "a.txt", "1\n2\n3\n", "Base");
    let target = git(&root, &["rev-parse", "HEAD"]).trim().to_owned();
    git(&root, &["switch", "-q", "-c", "feature"]);
    commit_file(&root, "f.txt", "f\n", "Feature");
    git(&root, &["switch", "-q", "main"]);
    commit_file(&root, "a.txt", "1\n2\nthree\n", "Main change");
    git(&root, &["merge", "-q", "--no-ff", "-m", "Merge feature", "feature"]);

    edit_file(&g, &root, &target, "a.txt", b"one\n2\n3\n").unwrap();
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "one\n2\nthree\n");
    let parents = git(&root, &["log", "-1", "--format=%P"]);
    assert_eq!(parents.split_whitespace().count(), 2);
    // Both sides of the merge now start from the edited commit.
    assert_eq!(git(&root, &["show", "HEAD^2~1:a.txt"]), "one\n2\n3\n");
    assert!(fs::metadata(root.join("f.txt")).is_ok());
    assert!(status(&root).is_clean());
}

#[test]
fn tells_where_a_branch_is_checked_out_in_another_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let root = new_repo(&dir.path().join("r"));
    let g = Git::default();
    commit_file(&root, "a.txt", "a\n", "First");
    git(&root, &["branch", "other"]);
    let wt = dir.path().join("wt");
    git(&root, &["worktree", "add", "-q", wt.to_str().unwrap(), "other"]);

    let other = refs::list(&g, &root).unwrap().local.into_iter().find(|b| b.name == "other").unwrap();
    assert!(other.worktree.as_deref().is_some_and(|p| p.ends_with("wt")), "{other:?}");
    let err = refs::switch(&g, &root, "other", false).unwrap_err();
    assert!(matches!(err, GitError::BranchInWorktree(ref p) if p.ends_with("wt")), "{err:?}");
}

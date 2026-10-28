//! Operations that stop on conflicts (merge, rebase, cherry-pick, revert): continuing, skipping the
//! current commit or aborting them, and resolving each conflicted file from its three versions.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::repo::Operation;
use crate::status::{parse_status, STATUS_ARGS};
use crate::{Git, GitError};

/// Where an operation stands after a step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Progress {
    /// Finished: nothing is in progress any more.
    Done,
    /// Stopped again, on the conflicts of the next commit.
    Conflicts,
}

/// Commits what was resolved and goes on with the operation in progress.
pub fn continue_operation(git: &Git, root: &Path) -> Result<Progress, GitError> {
    let operation = current(git, root)?;
    let remaining = parse_status(&git.output(root, STATUS_ARGS)?)?.conflicted();
    if remaining > 0 {
        return Err(GitError::ConflictsRemain(remaining));
    }
    let args: &[&str] = match operation {
        Operation::Rebase => &["rebase", "--continue"],
        Operation::Merge => &["merge", "--continue"],
        Operation::CherryPick => &["cherry-pick", "--continue"],
        Operation::Revert => &["revert", "--continue"],
        Operation::Bisect => return Err(GitError::Failed { command: "bisect".into(), message: "a bisect is not continued from here".into() }),
    };
    step(git, root, args)
}

/// Leaves out the commit being applied (rebase, cherry-pick) and goes on with the next one.
pub fn skip_commit(git: &Git, root: &Path) -> Result<Progress, GitError> {
    let args: &[&str] = match current(git, root)? {
        Operation::Rebase => &["rebase", "--skip"],
        Operation::CherryPick => &["cherry-pick", "--skip"],
        Operation::Revert => &["revert", "--skip"],
        Operation::Merge | Operation::Bisect => {
            return Err(GitError::Failed { command: "skip".into(), message: "only a rebase, a cherry-pick or a revert can skip a commit".into() });
        }
    };
    step(git, root, args)
}

/// Gives up the operation in progress: the branch is back where it was before it started.
pub fn abort_operation(git: &Git, root: &Path) -> Result<(), GitError> {
    let args: &[&str] = match current(git, root)? {
        Operation::Rebase => &["rebase", "--abort"],
        Operation::Merge => &["merge", "--abort"],
        Operation::CherryPick => &["cherry-pick", "--abort"],
        Operation::Revert => &["revert", "--abort"],
        Operation::Bisect => &["bisect", "reset"],
    };
    git.output(root, args)?;
    Ok(())
}

fn current(git: &Git, root: &Path) -> Result<Operation, GitError> {
    let dir = git.text(root, ["rev-parse", "--absolute-git-dir"])?;
    Operation::detect(Path::new(dir.trim())).ok_or(GitError::NoOperation)
}

/// Runs a step of the operation; stopping on new conflicts is an outcome, not a failure.
fn step(git: &Git, root: &Path, args: &[&str]) -> Result<Progress, GitError> {
    let out = git.raw(root, args)?;
    let dir = git.text(root, ["rev-parse", "--absolute-git-dir"])?;
    let in_progress = Operation::detect(Path::new(dir.trim())).is_some();
    if out.status.success() {
        return Ok(if in_progress { Progress::Conflicts } else { Progress::Done });
    }
    if in_progress && parse_status(&git.output(root, STATUS_ARGS)?)?.conflicted() > 0 {
        return Ok(Progress::Conflicts);
    }
    let text = format!("{}{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
    // The resolution left the commit without any change: it can only be skipped.
    if ["nothing to commit", "No changes", "is now empty"].iter().any(|n| text.contains(n)) {
        return Err(GitError::EmptyAfterResolution);
    }
    Err(crate::error::classify(args.join(" "), text.trim().to_owned(), &text))
}

/// A conflicted file, as the conflict editor shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    /// Each side and the common ancestor; `None` when the file does not exist there (deleted on
    /// one side, or added on both).
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub base: Option<String>,
    /// The file as it is in the working copy, with the conflict markers git left (or the user's
    /// edits).
    pub working: Option<String>,
    /// The three-way merge of the sides, cut in parts that agree and parts in conflict.
    pub segments: Vec<Segment>,
    /// One of the versions is not text: only a whole side can be chosen.
    pub binary: bool,
    pub sides: Sides,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Segment {
    /// Lines both sides agree on (or that only one side changed), kept as they are.
    Common { text: String },
    Conflict { ours: String, base: String, theirs: String },
}

/// What « ours » and « theirs » are in the operation in progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sides {
    pub operation: Option<Operation>,
    pub ours: Side,
    pub theirs: Side,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    /// A branch name when there is one.
    pub name: Option<String>,
    pub oid: Option<String>,
    pub summary: Option<String>,
}

/// The versions of a conflicted file and how they merge.
pub fn conflict_file(git: &Git, root: &Path, path: &str) -> Result<ConflictFile, GitError> {
    let stage = |n: u8| -> Result<Option<Vec<u8>>, GitError> {
        let out = git.raw(root, &["show", &format!(":{n}:{path}")])?;
        Ok(out.status.success().then_some(out.stdout))
    };
    let (base, ours, theirs) = (stage(1)?, stage(2)?, stage(3)?);
    let working = fs::read(root.join(path)).ok();
    let as_text = |bytes: &Option<Vec<u8>>| bytes.as_ref().map(|b| String::from_utf8(b.clone()).ok());
    let texts = [as_text(&base), as_text(&ours), as_text(&theirs), as_text(&working)];
    let binary = texts.iter().any(|t| matches!(t, Some(None)));
    let [base_text, ours_text, theirs_text, working_text] = texts.map(Option::flatten);
    let segments = match (&ours, &theirs, binary) {
        (Some(o), Some(t), false) => segments(git, root, o, base.as_deref().unwrap_or_default(), t)?,
        _ => Vec::new(),
    };
    Ok(ConflictFile {
        path: path.to_owned(),
        ours: ours_text,
        theirs: theirs_text,
        base: base_text,
        working: working_text,
        segments,
        binary,
        sides: sides(git, root)?,
    })
}

const OURS: &str = "<<<<<<< ";
const BASE: &str = "||||||| ";
const SPLIT: &str = "=======";
const THEIRS: &str = ">>>>>>> ";

/// Three-way merge of the sides with `merge-file --diff3`, read back into segments.
fn segments(git: &Git, root: &Path, ours: &[u8], base: &[u8], theirs: &[u8]) -> Result<Vec<Segment>, GitError> {
    let dir = std::env::temp_dir().join(format!("ramelo-conflict-{}-{:x}", std::process::id(), hash(ours, theirs)));
    fs::create_dir_all(&dir).map_err(|source| GitError::Io { path: dir.clone(), source })?;
    let result = (|| {
        let mut files = Vec::new();
        for (name, bytes) in [("ours", ours), ("base", base), ("theirs", theirs)] {
            let file = dir.join(name);
            fs::write(&file, bytes).map_err(|source| GitError::Io { path: file.clone(), source })?;
            files.push(file);
        }
        let args = [
            "merge-file".as_ref(), "-p".as_ref(), "--diff3".as_ref(),
            "-L".as_ref(), "ours".as_ref(), "-L".as_ref(), "base".as_ref(), "-L".as_ref(), "theirs".as_ref(),
            files[0].as_os_str(), files[1].as_os_str(), files[2].as_os_str(),
        ];
        let out = git.raw(root, &args)?;
        Ok(parse_segments(&String::from_utf8_lossy(&out.stdout)))
    })();
    let _ = fs::remove_dir_all(&dir);
    result
}

fn hash(a: &[u8], b: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (a, b).hash(&mut hasher);
    hasher.finish()
}

/// Cuts a file with diff3 conflict markers into segments. Line endings are kept.
pub(crate) fn parse_segments(merged: &str) -> Vec<Segment> {
    enum In {
        Common,
        Ours,
        Base,
        Theirs,
    }
    let mut segments = Vec::new();
    let (mut common, mut ours, mut base, mut theirs) = (String::new(), String::new(), String::new(), String::new());
    // The lines of the block being read, markers included, in case it is never closed.
    let mut raw = String::new();
    let mut state = In::Common;
    for line in merged.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if !matches!(state, In::Common) || bare.starts_with(OURS) {
            raw.push_str(line);
        }
        match state {
            In::Common if bare.starts_with(OURS) => {
                if !common.is_empty() {
                    segments.push(Segment::Common { text: std::mem::take(&mut common) });
                }
                state = In::Ours;
            }
            In::Common => common.push_str(line),
            In::Ours if bare.starts_with(BASE) => state = In::Base,
            In::Ours | In::Base if bare == SPLIT => state = In::Theirs,
            In::Ours => ours.push_str(line),
            In::Base => base.push_str(line),
            In::Theirs if bare.starts_with(THEIRS) => {
                segments.push(Segment::Conflict {
                    ours: std::mem::take(&mut ours),
                    base: std::mem::take(&mut base),
                    theirs: std::mem::take(&mut theirs),
                });
                raw.clear();
                state = In::Common;
            }
            In::Theirs => theirs.push_str(line),
        }
    }
    // An unfinished block (markers in the content itself): kept as plain text.
    if !matches!(state, In::Common) {
        if let Some(Segment::Common { text }) = segments.last_mut().filter(|_| common.is_empty()) {
            text.push_str(&raw);
        } else {
            common.push_str(&raw);
        }
    }
    if !common.is_empty() {
        segments.push(Segment::Common { text: common });
    }
    segments
}

fn sides(git: &Git, root: &Path) -> Result<Sides, GitError> {
    let dir = git.text(root, ["rev-parse", "--absolute-git-dir"])?;
    let dir = Path::new(dir.trim());
    let operation = Operation::detect(dir);
    let read = |name: &str| fs::read_to_string(dir.join(name)).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let side = |oid: Option<String>, name: Option<String>| -> Side {
        let summary = oid.as_ref().and_then(|o| git.text(root, ["log", "-1", "--format=%s", o]).ok()).map(|s| s.trim().to_owned());
        Side { name, oid, summary }
    };
    let head_oid = git.text(root, ["rev-parse", "--verify", "-q", "HEAD"]).ok().map(|s| s.trim().to_owned());
    let head_branch = git.text(root, ["symbolic-ref", "-q", "--short", "HEAD"]).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let (ours, theirs) = match operation {
        // A rebase replays the branch's commits on the new base: « ours » is that base, « theirs »
        // the commit being applied.
        Some(Operation::Rebase) => {
            let branch = read("rebase-merge/head-name").or_else(|| read("rebase-apply/head-name")).map(|n| n.trim_start_matches("refs/heads/").to_owned());
            let onto = read("rebase-merge/onto").or_else(|| read("rebase-apply/onto"));
            let onto_name = onto.as_ref().and_then(|o| git.text(root, ["name-rev", "--name-only", "--no-undefined", "--exclude=refs/tags/*", o]).ok()).map(|s| s.trim().to_owned());
            (side(head_oid.or(onto), onto_name), side(read("REBASE_HEAD"), branch))
        }
        Some(Operation::Merge) => {
            let theirs = read("MERGE_HEAD").and_then(|m| m.lines().next().map(str::to_owned));
            let name = theirs.as_ref().and_then(|o| git.text(root, ["name-rev", "--name-only", "--no-undefined", o]).ok()).map(|s| s.trim().to_owned());
            (side(head_oid, head_branch), side(theirs, name))
        }
        Some(Operation::CherryPick) => (side(head_oid, head_branch), side(read("CHERRY_PICK_HEAD"), None)),
        Some(Operation::Revert) => (side(head_oid, head_branch), side(read("REVERT_HEAD"), None)),
        // Changes re-applied from a stash, or nothing known.
        _ => (side(head_oid, head_branch), side(None, None)),
    };
    Ok(Sides { operation, ours, theirs })
}

/// Marks a conflicted file resolved with `content`, or with the file deleted when it is `None`.
pub fn resolve_file(git: &Git, root: &Path, path: &str, content: Option<&[u8]>) -> Result<(), GitError> {
    let file = root.join(path);
    match content {
        Some(bytes) => {
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent).map_err(|source| GitError::Io { path: parent.to_path_buf(), source })?;
            }
            fs::write(&file, bytes).map_err(|source| GitError::Io { path: file.clone(), source })?;
            git.output(root, ["add", "--", path])?;
        }
        None => {
            git.output(root, ["rm", "-q", "--ignore-unmatch", "--", path])?;
        }
    }
    Ok(())
}

/// Marks a conflicted file resolved with one side as it is (`theirs` or ours): the way to settle a
/// binary file, or a file deleted on one side (taking that side deletes it).
pub fn take_side(git: &Git, root: &Path, path: &str, theirs: bool) -> Result<(), GitError> {
    let stage = if theirs { 3 } else { 2 };
    let exists = git.raw(root, &["cat-file", "-e", &format!(":{stage}:{path}")])?.status.success();
    if exists {
        git.output(root, ["checkout", if theirs { "--theirs" } else { "--ours" }, "--", path])?;
        git.output(root, ["add", "--", path])?;
    } else {
        git.output(root, ["rm", "-q", "--ignore-unmatch", "--", path])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_diff3_output_into_segments() {
        let merged = "a\n<<<<<<< ours\nb1\n||||||| base\nb\n=======\nb2\nb3\n>>>>>>> theirs\nc\r\n";
        assert_eq!(
            parse_segments(merged),
            [
                Segment::Common { text: "a\n".into() },
                Segment::Conflict { ours: "b1\n".into(), base: "b\n".into(), theirs: "b2\nb3\n".into() },
                Segment::Common { text: "c\r\n".into() },
            ]
        );
        assert_eq!(parse_segments("x\n<<<<<<< not closed\ny\n"), [Segment::Common { text: "x\n<<<<<<< not closed\ny\n".into() }]);
    }
}

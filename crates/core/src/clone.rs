//! Cloning a repository, with git's progress handed on as it comes and a way to stop it.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::classify;
use crate::{Git, GitError};

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CloneOptions {
    /// Branch to check out instead of the remote's default one.
    pub branch: Option<String>,
    /// Also clone the submodules.
    pub submodules: bool,
}

/// A step of the clone, as git reports it: « Receiving objects », 42 %.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    pub phase: String,
    pub percent: Option<u8>,
    /// The rest of git's line (« (420/1000), 1.20 MiB | 2.00 MiB/s »).
    pub detail: String,
}

/// Clones `url` into `target`, which must not exist or be an empty folder. On a failure or when
/// stopped, a folder created for the clone is removed again.
pub fn clone(
    git: &Git,
    url: &str,
    target: &Path,
    options: &CloneOptions,
    mut on_progress: impl FnMut(CloneProgress),
    cancelled: &dyn Fn() -> bool,
) -> Result<PathBuf, GitError> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Err(GitError::InvalidUrl(url.to_owned()));
    }
    let existed = target.exists();
    if existed && fs::read_dir(target).map_or(true, |mut entries| entries.next().is_some()) {
        return Err(GitError::TargetExists(target.to_path_buf()));
    }
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|source| GitError::Io { path: parent.to_path_buf(), source })?;

    let mut args: Vec<String> = vec!["clone".into(), "--progress".into()];
    if let Some(branch) = options.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        args.extend(["--branch".into(), branch.to_owned()]);
    }
    if options.submodules {
        args.push("--recurse-submodules".into());
    }
    args.extend(["--".into(), url.to_owned(), target.display().to_string()]);

    let result = git.streaming(parent, &args, |line| {
        if let Some(progress) = parse_progress(line) {
            on_progress(progress);
        }
    }, cancelled);
    let failed = |error: GitError| {
        if !existed {
            let _ = fs::remove_dir_all(target);
        }
        Err(error)
    };
    let out = match result {
        Ok(out) => out,
        Err(error) => return failed(error),
    };
    if !out.status.success() {
        let text = String::from_utf8_lossy(&out.stderr).into_owned();
        let message = text.lines().rev().map(str::trim).find(|l| l.starts_with("fatal:") || l.starts_with("error:")).unwrap_or(text.trim());
        let message = message.trim_start_matches("fatal: ").trim_start_matches("error: ").to_owned();
        return failed(classify("clone".into(), message, &text));
    }
    Ok(fs::canonicalize(target).map(strip_verbatim).unwrap_or_else(|_| target.to_path_buf()))
}

/// « \\?\C:\dev\x » → « C:\dev\x » on Windows: the form the rest of the application uses.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").map_or(path, PathBuf::from)
}

/// « Receiving objects:  42% (420/1000), 1.20 MiB | 2.00 MiB/s » → phase, percent and the rest.
fn parse_progress(line: &str) -> Option<CloneProgress> {
    let line = line.trim().trim_start_matches("remote: ").trim();
    if line.is_empty() {
        return None;
    }
    let Some((phase, rest)) = line.split_once(':') else {
        // « Cloning into 'name'... »
        return line.starts_with("Cloning into").then(|| CloneProgress { phase: "Cloning".into(), percent: None, detail: String::new() });
    };
    let rest = rest.trim();
    let percent = rest.split_once('%').and_then(|(n, _)| n.trim().parse::<u8>().ok());
    let detail = rest.split_once('%').map_or(rest, |(_, d)| d).trim().trim_end_matches(", done.").to_owned();
    // Lines that are not progress (warnings, hints) are left out.
    (percent.is_some() || phase.ends_with("objects") || phase.ends_with("deltas") || phase.ends_with("files"))
        .then(|| CloneProgress { phase: phase.trim().to_owned(), percent, detail })
}

/// The folder name a clone of `url` gets by default: its last part, without « .git ».
pub fn clone_name(url: &str) -> String {
    let url = url.trim().trim_end_matches(['/', '\\']);
    let last = url.rsplit(['/', '\\', ':']).next().unwrap_or(url);
    last.strip_suffix(".git").unwrap_or(last).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_progress_lines() {
        let p = parse_progress("Receiving objects:  42% (420/1000), 1.20 MiB | 2.00 MiB/s").unwrap();
        assert_eq!((p.phase.as_str(), p.percent, p.detail.as_str()), ("Receiving objects", Some(42), "(420/1000), 1.20 MiB | 2.00 MiB/s"));
        let p = parse_progress("remote: Counting objects: 100% (5/5), done.").unwrap();
        assert_eq!((p.phase.as_str(), p.percent), ("Counting objects", Some(100)));
        assert!(parse_progress("warning: You appear to have cloned an empty repository.").is_none());
    }

    #[test]
    fn names_the_folder_after_the_url() {
        assert_eq!(clone_name("https://github.com/org/ramelo.git"), "ramelo");
        assert_eq!(clone_name("git@github.com:org/tool.git"), "tool");
        assert_eq!(clone_name("C:\\dev\\local-repo\\"), "local-repo");
        assert_eq!(clone_name("ssh://host/path/project"), "project");
    }
}

//! Runs the `git` command line.
//!
//! Output is read as bytes: with `-z`, paths are separated by NUL and never quoted, so file names
//! with spaces, accents or newlines come back intact.

use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::GitError;

/// The git executable used for every operation.
#[derive(Debug, Clone)]
pub struct Git {
    program: PathBuf,
}

impl Default for Git {
    fn default() -> Self {
        Self { program: PathBuf::from("git") }
    }
}

impl Git {
    /// Uses a specific git executable instead of the one found in the PATH.
    pub fn with_program(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into() }
    }

    /// Version reported by `git --version` (for example « 2.47.1.windows.1 »).
    pub fn version(&self) -> Result<String, GitError> {
        let out = self.output(Path::new("."), ["--version"])?;
        let text = String::from_utf8_lossy(&out);
        Ok(text.trim().trim_start_matches("git version ").to_owned())
    }

    /// Runs `git <args>` in `dir` and returns its standard output; a non-zero exit is an error
    /// carrying git's own message.
    pub fn output<I, S>(&self, dir: &Path, args: I) -> Result<Vec<u8>, GitError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args: Vec<S> = args.into_iter().collect();
        let out = self.raw(dir, &args)?;
        if out.status.success() {
            Ok(out.stdout)
        } else {
            Err(GitError::Failed { command: describe(&args), message: failure_message(&out) })
        }
    }

    /// Like [`Git::output`], decoded as UTF-8 (invalid bytes are replaced).
    pub fn text<I, S>(&self, dir: &Path, args: I) -> Result<String, GitError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.output(dir, args).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Runs git and returns the whole result, whatever the exit code.
    pub fn raw<S: AsRef<OsStr>>(&self, dir: &Path, args: &[S]) -> Result<Output, GitError> {
        let mut command = Command::new(&self.program);
        command
            .current_dir(dir)
            // Stable, untranslated messages and never an interactive prompt that would hang.
            .env("LC_ALL", "C")
            .env("LANGUAGE", "C")
            .env("GIT_TERMINAL_PROMPT", "0")
            // Reading the state must not take the index lock away from the user's other tools.
            .env("GIT_OPTIONAL_LOCKS", "0")
            .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
            .args(args);
        hide_console(&mut command);
        command.output().map_err(|source| match source.kind() {
            ErrorKind::NotFound if dir.exists() => GitError::GitNotFound,
            ErrorKind::NotFound => GitError::PathMissing(dir.to_path_buf()),
            _ => GitError::Io { path: dir.to_path_buf(), source },
        })
    }
}

/// Without this flag, each git call would flash a console window on Windows.
#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_: &mut Command) {}

fn describe<S: AsRef<OsStr>>(args: &[S]) -> String {
    args.iter().map(|a| a.as_ref().to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ")
}

/// The most useful line of git's error output: « fatal: … » or « error: … » when there is one.
fn failure_message(out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let message = lines
        .iter()
        .find(|l| l.starts_with("fatal:") || l.starts_with("error:"))
        .or(lines.first())
        .map(|l| l.trim_start_matches("fatal: ").trim_start_matches("error: ").to_owned());
    message.unwrap_or_else(|| match out.status.code() {
        Some(code) => format!("exit code {code}"),
        None => "interrupted".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_version_and_git_errors() {
        let git = Git::default();
        assert!(git.version().unwrap().chars().next().unwrap().is_ascii_digit());

        let dir = tempfile::tempdir().unwrap();
        let error = git.output(dir.path(), ["rev-parse", "HEAD"]).unwrap_err();
        let GitError::Failed { command, message } = error else { panic!("unexpected {error:?}") };
        assert_eq!(command, "rev-parse HEAD");
        assert!(message.contains("not a git repository"), "{message}");
    }

    #[test]
    fn tells_a_missing_git_from_a_missing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let missing_git = Git::with_program(dir.path().join("no-such-git"));
        assert!(matches!(missing_git.version(), Err(GitError::GitNotFound)));
        let missing_dir = dir.path().join("gone");
        assert!(matches!(Git::default().output(&missing_dir, ["status"]), Err(GitError::PathMissing(_))));
    }
}

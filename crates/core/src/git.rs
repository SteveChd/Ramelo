//! Runs the `git` command line.
//!
//! Output is read as bytes: with `-z`, paths are separated by NUL and never quoted, so file names
//! with spaces, accents or newlines come back intact.

use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::io::{Read, Write};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use crate::error::classify;
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
        checked(&args, self.raw(dir, &args)?)
    }

    /// Like [`Git::output`], with `input` sent to git's standard input (a patch, a commit message…).
    pub fn output_with_input<S: AsRef<OsStr>>(&self, dir: &Path, args: &[S], input: &[u8]) -> Result<Vec<u8>, GitError> {
        checked(args, self.run(dir, args, Some(input))?)
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
        self.run(dir, args, None)
    }

    /// Runs git, handing each line of its error output to `on_line` as it comes (progress lines
    /// end with « \r » and are handed one by one). `cancelled` is asked a few times a second; when
    /// it answers true, git is stopped and [`GitError::Cancelled`] returned.
    pub fn streaming<S: AsRef<OsStr>>(
        &self,
        dir: &Path,
        args: &[S],
        mut on_line: impl FnMut(&str),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Output, GitError> {
        let mut command = self.command(dir, args);
        command.stdin(Stdio::null());
        let io_error = |source: std::io::Error| GitError::Io { path: dir.to_path_buf(), source };
        let mut child = command.spawn().map_err(|source| match source.kind() {
            ErrorKind::NotFound if dir.exists() => GitError::GitNotFound,
            _ => io_error(source),
        })?;
        let mut stderr = child.stderr.take().expect("stderr is piped");
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let out_reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stdout.read_to_end(&mut bytes);
            bytes
        });
        let (sender, lines) = mpsc::channel::<String>();
        let err_reader = std::thread::spawn(move || {
            let (mut all, mut line, mut buffer) = (Vec::new(), Vec::new(), [0u8; 4096]);
            while let Ok(n) = stderr.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                all.extend_from_slice(&buffer[..n]);
                for &byte in &buffer[..n] {
                    if byte == b'\r' || byte == b'\n' {
                        if !line.is_empty() {
                            let _ = sender.send(String::from_utf8_lossy(&line).into_owned());
                            line.clear();
                        }
                    } else {
                        line.push(byte);
                    }
                }
            }
            if !line.is_empty() {
                let _ = sender.send(String::from_utf8_lossy(&line).into_owned());
            }
            all
        });
        let mut stopped = false;
        loop {
            match lines.recv_timeout(Duration::from_millis(150)) {
                Ok(line) => on_line(&line),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if !stopped && cancelled() {
                stopped = true;
                let _ = child.kill();
            }
        }
        let status = child.wait().map_err(io_error)?;
        let stderr = err_reader.join().unwrap_or_default();
        let stdout = out_reader.join().unwrap_or_default();
        if stopped {
            return Err(GitError::Cancelled);
        }
        Ok(Output { status, stdout, stderr })
    }

    /// Like [`Git::output`] for an output already read: a non-zero exit is an error.
    pub fn check<S: AsRef<OsStr>>(args: &[S], out: Output) -> Result<Vec<u8>, GitError> {
        checked(args, out)
    }

    fn command<S: AsRef<OsStr>>(&self, dir: &Path, args: &[S]) -> Command {
        let mut command = Command::new(&self.program);
        command
            .current_dir(dir)
            // Stable, untranslated messages and never an interactive prompt that would hang.
            .env("LC_ALL", "C")
            .env("LANGUAGE", "C")
            .env("GIT_TERMINAL_PROMPT", "0")
            // Continuing a merge or a rebase takes the message git prepared instead of opening an
            // editor, which could not work without a terminal anyway.
            .env("GIT_EDITOR", "true")
            // Reading the state must not take the index lock away from the user's other tools.
            .env("GIT_OPTIONAL_LOCKS", "0")
            .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut command);
        command
    }

    fn run<S: AsRef<OsStr>>(&self, dir: &Path, args: &[S], input: Option<&[u8]>) -> Result<Output, GitError> {
        let mut command = self.command(dir, args);
        // Without a terminal, ssh and editors fail at once instead of waiting for an answer.
        command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
        let spawn_error = |source: std::io::Error| match source.kind() {
            ErrorKind::NotFound if dir.exists() => GitError::GitNotFound,
            ErrorKind::NotFound => GitError::PathMissing(dir.to_path_buf()),
            _ => GitError::Io { path: dir.to_path_buf(), source },
        };
        let mut child = command.spawn().map_err(spawn_error)?;
        if let Some(input) = input {
            let mut stdin = child.stdin.take().expect("stdin is piped");
            // Written from another thread: a large input could otherwise fill the pipe while git
            // waits for us to read its output.
            let input = input.to_vec();
            std::thread::spawn(move || {
                let _ = stdin.write_all(&input);
            });
        }
        child.wait_with_output().map_err(|source| GitError::Io { path: dir.to_path_buf(), source })
    }
}

fn checked<S: AsRef<OsStr>>(args: &[S], out: Output) -> Result<Vec<u8>, GitError> {
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let all = format!("{}\n{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
        Err(classify(describe(args), failure_message(&out), &all))
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
    let stdout = String::from_utf8_lossy(&out.stdout);
    // Some commands (`commit` with nothing to commit) only explain themselves on standard output.
    let text = if stderr.trim().is_empty() { &stdout } else { &stderr };
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
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

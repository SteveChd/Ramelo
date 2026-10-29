//! Servers that ssh does not know yet. In a terminal, ssh shows the fingerprint of a new server and
//! asks whether to trust it; git run without a terminal cannot answer, and the clone or the fetch
//! fails. Here the keys of the server are read with `ssh-keyscan`, shown to the user with their
//! fingerprints, and the ones the user accepted are added to `~/.ssh/known_hosts`, as ssh would.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::GitError;
use crate::git::{hide_console, Git};

/// Seconds `ssh-keyscan` waits for the server.
const SCAN_TIMEOUT: &str = "10";

/// A key of a server, as `ssh-keyscan` gives it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    /// « ssh-ed25519 », « ecdsa-sha2-nistp256 », « ssh-rsa »…
    pub kind: String,
    /// « SHA256:… », as ssh shows it.
    pub fingerprint: String,
    #[serde(skip)]
    line: String,
}

/// The server of an ssh address, as `known_hosts` names it: « host », or « [host]:port » for another
/// port than 22. `None` for an address that is not ssh (https, a folder).
pub fn ssh_host(url: &str) -> Option<String> {
    let url = url.trim();
    let authority = if let Some(rest) = url.strip_prefix("ssh://").or_else(|| url.strip_prefix("git+ssh://")) {
        rest.split('/').next()?
    } else if url.contains("://") {
        return None;
    } else {
        // « user@host:path »: a colon before any slash (a Windows path « C:\… » has no user and one letter).
        let (before, _) = url.split_once(':')?;
        if before.contains('/') || (!before.contains('@') && before.len() == 1) {
            return None;
        }
        before
    };
    let host_port = authority.rsplit('@').next()?;
    let (host, port) = match host_port.strip_prefix('[') {
        Some(rest) => {
            let (host, after) = rest.split_once(']')?;
            (host, after.strip_prefix(':'))
        }
        None => match host_port.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (host_port, None),
        },
    };
    if host.is_empty() {
        return None;
    }
    Some(match port.filter(|p| !p.is_empty() && *p != "22") {
        Some(port) => format!("[{host}]:{port}"),
        None => host.to_owned(),
    })
}

/// The keys of `host` (as [`ssh_host`] gives it), read from the server.
pub fn scan_host_keys(git: &Git, host: &str) -> Result<Vec<HostKey>, GitError> {
    let (name, port) = match host.strip_prefix('[').and_then(|r| r.split_once("]:")) {
        Some((name, port)) => (name, Some(port)),
        None => (host, None),
    };
    let mut args = vec!["-T", SCAN_TIMEOUT];
    if let Some(port) = port {
        args.extend(["-p", port]);
    }
    args.push(name);
    let mut command = Command::new(keyscan_program(git));
    command.args(&args).stdin(Stdio::null());
    hide_console(&mut command);
    let out = command.output().map_err(|e| GitError::Failed { command: "ssh-keyscan".into(), message: e.to_string() })?;
    let keys = parse_keys(&String::from_utf8_lossy(&out.stdout));
    if keys.is_empty() {
        let message = String::from_utf8_lossy(&out.stderr).lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).map_or_else(
            || format!("no key was read from {host}"),
            str::to_owned,
        );
        return Err(GitError::Failed { command: format!("ssh-keyscan {}", args.join(" ")), message });
    }
    Ok(keys)
}

/// Adds the keys of `host` whose fingerprints are in `accepted` to the known hosts. The keys are read
/// again: only those the user saw are kept. Returns how many were added.
pub fn trust_host(git: &Git, host: &str, accepted: &[String]) -> Result<usize, GitError> {
    let keys: Vec<HostKey> = scan_host_keys(git, host)?.into_iter().filter(|k| accepted.contains(&k.fingerprint)).collect();
    if keys.is_empty() {
        return Err(GitError::Failed { command: "ssh-keyscan".into(), message: format!("the keys of {host} changed since they were shown") });
    }
    let file = known_hosts().ok_or_else(|| GitError::Failed { command: "known_hosts".into(), message: "no home folder".into() })?;
    append(&file, &keys)?;
    Ok(keys.len())
}

fn append(file: &Path, keys: &[HostKey]) -> Result<(), GitError> {
    let io = |source| GitError::Io { path: file.to_path_buf(), source };
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(io)?;
    }
    let ends_with_newline = fs::read(file).map_or(true, |bytes| bytes.is_empty() || bytes.ends_with(b"\n"));
    let mut out = OpenOptions::new().create(true).append(true).open(file).map_err(io)?;
    let mut text = if ends_with_newline { String::new() } else { "\n".to_owned() };
    for key in keys {
        text.push_str(&key.line);
        text.push('\n');
    }
    out.write_all(text.as_bytes()).map_err(io)
}

/// The file ssh reads: in the home folder that git's ssh uses (HOME, set by Git for Windows, or the
/// user's profile).
fn known_hosts() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty()).or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".ssh").join("known_hosts"))
}

/// `ssh-keyscan` from the PATH, or the one that comes with Git for Windows when there is none.
fn keyscan_program(git: &Git) -> PathBuf {
    let name = if cfg!(windows) { "ssh-keyscan.exe" } else { "ssh-keyscan" };
    let in_path = std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()));
    if !in_path {
        // « …\Git\mingw64\libexec\git-core » → « …\Git\usr\bin ».
        if let Ok(exec) = git.text(Path::new("."), ["--exec-path"]) {
            let bundled = Path::new(exec.trim()).ancestors().nth(3).map(|root| root.join("usr").join("bin").join(name));
            if let Some(bundled) = bundled.filter(|p| p.is_file()) {
                return bundled;
            }
        }
    }
    PathBuf::from(name)
}

fn parse_keys(text: &str) -> Vec<HostKey> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let (_, kind, key) = (fields.next()?, fields.next()?, fields.next()?);
            let blob = base64::engine::general_purpose::STANDARD.decode(key).ok()?;
            let digest = base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(&blob));
            Some(HostKey { kind: kind.to_owned(), fingerprint: format!("SHA256:{digest}"), line: line.to_owned() })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_server_of_an_address() {
        assert_eq!(ssh_host("git@ssh.bitbucket.org:acme/tool.git").as_deref(), Some("ssh.bitbucket.org"));
        assert_eq!(ssh_host("ssh://git@bb.corp:7999/plat/tool.git").as_deref(), Some("[bb.corp]:7999"));
        assert_eq!(ssh_host("ssh://git@github.com:22/a/b.git").as_deref(), Some("github.com"));
        assert_eq!(ssh_host("ssh://[::1]:2222/x").as_deref(), Some("[::1]:2222"));
        assert_eq!(ssh_host("https://github.com/a/b.git"), None);
        assert_eq!(ssh_host("C:\\dev\\repo"), None);
        assert_eq!(ssh_host("../other/repo"), None);
    }

    #[test]
    fn reads_keys_and_their_fingerprints() {
        // The published key of github.com and its published fingerprint.
        let text = "# github.com:22 SSH-2.0-babeld\ngithub.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";
        let keys = parse_keys(text);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].kind, "ssh-ed25519");
        assert_eq!(keys[0].fingerprint, "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU");
    }

    #[test]
    fn appends_on_a_line_of_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".ssh").join("known_hosts");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "old ssh-ed25519 AAAA").unwrap();
        let keys = parse_keys("new ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl");
        append(&file, &keys).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.ends_with("GKJl\n"));
    }
}

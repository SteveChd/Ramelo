//! Search through the whole history (every branch, remote branch and tag), not only the commits
//! read for the graph: by message, author, commit id, changed file, or changed code.

use std::collections::HashSet;
use std::path::Path;

use serde::Deserialize;

use crate::{Git, GitError};

/// What the text is looked for in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchScope {
    /// Message, author or commit id.
    #[default]
    All,
    Message,
    Author,
    /// The start of the commit id.
    Sha,
    /// Path of a file the commit changed.
    File,
    /// Lines the commit added or removed.
    Code,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchQuery {
    pub text: String,
    pub scope: SearchScope,
    pub match_case: bool,
    /// The text is an extended regular expression (message, author, code).
    pub regex: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Matching commits, newest first.
    pub oids: Vec<String>,
    /// More commits match than `limit`.
    pub truncated: bool,
}

/// Commits matching `query`, at most `limit`.
pub fn search(git: &Git, root: &Path, query: &SearchQuery, limit: usize) -> Result<SearchResult, GitError> {
    let text = query.text.trim();
    if text.is_empty() {
        return Ok(SearchResult { oids: Vec::new(), truncated: false });
    }
    let mut found: Vec<(i64, String)> = Vec::new();
    let scopes: &[SearchScope] = match query.scope {
        SearchScope::All => &[SearchScope::Message, SearchScope::Author, SearchScope::Sha],
        _ => std::slice::from_ref(&query.scope),
    };
    for scope in scopes {
        found.extend(search_scope(git, root, text, *scope, query, limit)?);
    }
    // Newest first; a commit found by several scopes is kept once.
    found.sort_by_key(|(time, _)| std::cmp::Reverse(*time));
    let mut seen = HashSet::new();
    let mut oids: Vec<String> = found.into_iter().filter(|(_, oid)| seen.insert(oid.clone())).map(|(_, oid)| oid).collect();
    let truncated = oids.len() > limit;
    oids.truncate(limit);
    Ok(SearchResult { oids, truncated })
}

fn search_scope(git: &Git, root: &Path, text: &str, scope: SearchScope, query: &SearchQuery, limit: usize) -> Result<Vec<(i64, String)>, GitError> {
    let mut args: Vec<String> = ["log", "--branches", "--remotes", "--tags", "HEAD", "--format=%H%x1f%ct"].map(String::from).to_vec();
    let pattern = if query.regex { text.to_owned() } else { escape_regex(text) };
    let ignore_case = !query.match_case;
    match scope {
        SearchScope::Message => {
            args.push(format!("--grep={pattern}"));
            args.push("--extended-regexp".into());
        }
        SearchScope::Author => {
            args.push(format!("--author={pattern}"));
            args.push("--extended-regexp".into());
        }
        SearchScope::Code => {
            args.push(format!("-G{pattern}"));
        }
        // Every commit is listed and its id compared: a prefix can name several objects.
        SearchScope::Sha => {}
        SearchScope::File => {}
        SearchScope::All => unreachable!("expanded by the caller"),
    }
    if ignore_case && matches!(scope, SearchScope::Message | SearchScope::Author | SearchScope::Code) {
        args.push("--regexp-ignore-case".into());
    }
    if scope != SearchScope::Sha {
        args.push(format!("--max-count={}", limit + 1));
    }
    if scope == SearchScope::File {
        // A file whose name contains the text, or that is inside a folder whose name does.
        let magic = if ignore_case { "glob,icase" } else { "glob" };
        let glob = escape_glob(text);
        args.push("--".into());
        args.push(format!(":({magic})**/*{glob}*"));
        args.push(format!(":({magic})**/*{glob}*/**"));
    }

    let out = match git.output(root, &args) {
        Ok(out) => out,
        // No commit at all yet.
        Err(GitError::Failed { message, .. }) if message.contains("does not have any commits") || message.contains("unknown revision") => return Ok(Vec::new()),
        Err(GitError::Failed { message, .. }) if query.regex && is_regex_error(&message) => return Err(GitError::InvalidPattern(text.to_owned())),
        Err(error) => return Err(error),
    };
    let wanted = text.to_ascii_lowercase();
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|line| {
            let (oid, time) = line.split_once('\x1f')?;
            Some((time.trim().parse().ok()?, oid.to_owned()))
        })
        .filter(|(_, oid)| scope != SearchScope::Sha || oid.starts_with(&wanted))
        .collect())
}

/// « Unmatched ( or \( », « Invalid regular expression », « invalid regex: … ».
fn is_regex_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    ["regex", "regular expression", "unmatched", "invalid preceding", "trailing backslash"].iter().any(|m| message.contains(m))
}

/// Characters with a meaning in an extended regular expression, escaped.
fn escape_regex(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if r"\.^$|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Characters with a meaning in a glob pathspec, escaped.
fn escape_glob(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if r"\*?[]".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_what_has_a_meaning() {
        assert_eq!(escape_regex("a.b(c)*"), r"a\.b\(c\)\*");
        assert_eq!(escape_glob("x*[1]"), r"x\*\[1\]");
    }
}

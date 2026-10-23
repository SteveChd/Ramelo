//! Finds the repositories inside a folder, so that a whole workspace can be added in one go.
//!
//! The walk only looks at the file system (a `.git` folder or file marks a repository): it stays fast
//! on large trees and never starts git.

use std::fs;
use std::path::{Path, PathBuf};

/// How far the walk goes.
#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    /// Folder levels below the starting folder.
    pub depth: usize,
    /// The walk stops once this many repositories are found.
    pub max_repos: usize,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self { depth: 4, max_repos: 500 }
    }
}

/// Build output and dependency folders: huge, and never the home of a repository worth adding.
const SKIPPED: [&str; 6] = ["node_modules", "target", "build", "dist", "vendor", "__pycache__"];

/// Repositories found in `folder` (itself included), sorted by path. A repository's own subfolders
/// are not searched: nested repositories (submodules, vendored copies) belong to their parent.
pub fn scan(folder: &Path, limits: ScanLimits) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(folder, 0, limits, &mut found);
    found.sort();
    found
}

fn walk(dir: &Path, depth: usize, limits: ScanLimits, found: &mut Vec<PathBuf>) {
    if found.len() >= limits.max_repos {
        return;
    }
    if dir.join(".git").exists() {
        found.push(dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf()));
        return;
    }
    if depth >= limits.depth {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut subdirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        // Symbolic links are not followed: they could loop or leave the folder.
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && !SKIPPED.contains(&name.as_ref())
        })
        .map(|e| e.path())
        .collect();
    subdirs.sort();
    for subdir in subdirs {
        walk(&subdir, depth + 1, limits, found);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(root: &Path, relative: &str) -> PathBuf {
        let path = root.join(relative);
        fs::create_dir_all(path.join(".git")).unwrap();
        path
    }

    #[test]
    fn finds_nested_repositories_but_not_inside_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let app = repo(root, "apps/web");
        let lib = repo(root, "libs/core");
        repo(root, "apps/web/vendored/inner");
        repo(root, "node_modules/pkg");
        repo(root, ".cache/thing");
        repo(root, "a/b/c/d/e/too-deep");

        let found = scan(root, ScanLimits::default());
        let expected: Vec<PathBuf> = [app, lib].iter().map(|p| dunce::canonicalize(p).unwrap()).collect();
        assert_eq!(found, expected);
    }

    #[test]
    fn the_folder_itself_can_be_the_repository_and_the_count_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        let only = repo(dir.path(), "solo");
        assert_eq!(scan(&only, ScanLimits::default()), [dunce::canonicalize(&only).unwrap()]);

        for i in 0..5 {
            repo(dir.path(), &format!("many/r{i}"));
        }
        assert_eq!(scan(&dir.path().join("many"), ScanLimits { depth: 2, max_repos: 3 }).len(), 3);
    }
}

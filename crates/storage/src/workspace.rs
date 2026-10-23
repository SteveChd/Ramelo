//! The workspace: the repositories shown as tabs, in the user's order, and the one last viewed.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{atomic, StorageError};

const FILE_NAME: &str = "workspace.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    /// Top-level folder of the repository's working tree.
    pub path: PathBuf,
    /// Colour chosen by the user (« #rrggbb »); `None` lets the interface pick one from the name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspace {
    pub repositories: Vec<RepoEntry>,
    /// Repository shown at startup; `None` shows the overview of all repositories.
    pub active: Option<PathBuf>,
}

impl Workspace {
    /// Reads the workspace; a missing or unreadable file gives an empty workspace.
    pub fn load(dir: &Path) -> Self {
        let mut workspace: Self = fs::read_to_string(dir.join(FILE_NAME))
            .ok()
            .and_then(|text| serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok())
            .unwrap_or_default();
        if workspace.active.as_ref().is_some_and(|a| !workspace.contains(a)) {
            workspace.active = None;
        }
        workspace
    }

    pub fn save(&self, dir: &Path) -> Result<(), StorageError> {
        let path = dir.join(FILE_NAME);
        let json = serde_json::to_vec_pretty(self).map_err(|source| StorageError::Format { path: path.clone(), source })?;
        atomic::write(&path, &json)
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.repositories.iter().any(|r| r.path == path)
    }

    /// Adds a repository at the end of the tabs; returns false if it was already there.
    pub fn add(&mut self, path: PathBuf) -> bool {
        if self.contains(&path) {
            return false;
        }
        self.repositories.push(RepoEntry { path, color: None });
        true
    }

    /// Removes a repository from the workspace (the folder on disk is not touched). When it was the
    /// active one, its neighbour becomes active, as when closing a browser tab.
    pub fn remove(&mut self, path: &Path) {
        let Some(index) = self.repositories.iter().position(|r| r.path == path) else { return };
        self.repositories.remove(index);
        if self.active.as_deref() == Some(path) {
            let neighbour = self.repositories.get(index).or_else(|| index.checked_sub(1).and_then(|i| self.repositories.get(i)));
            self.active = neighbour.map(|r| r.path.clone());
        }
    }

    /// Sets the colour of a repository (`None`: back to the automatic one).
    pub fn set_color(&mut self, path: &Path, color: Option<String>) {
        if let Some(entry) = self.repositories.iter_mut().find(|r| r.path == path) {
            entry.color = color;
        }
    }

    /// Moves a tab to `index` (clamped to the number of tabs).
    pub fn reorder(&mut self, path: &Path, index: usize) {
        let Some(from) = self.repositories.iter().position(|r| r.path == path) else { return };
        let entry = self.repositories.remove(from);
        self.repositories.insert(index.min(self.repositories.len()), entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(names: &[&str]) -> Workspace {
        let mut w = Workspace::default();
        for name in names {
            w.add(PathBuf::from(name));
        }
        w
    }

    fn names(w: &Workspace) -> Vec<String> {
        w.repositories.iter().map(|r| r.path.display().to_string()).collect()
    }

    #[test]
    fn round_trips_and_survives_a_missing_or_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Workspace::load(dir.path()), Workspace::default());

        let mut w = workspace(&["/a", "/b"]);
        w.active = Some("/b".into());
        w.save(dir.path()).unwrap();
        assert_eq!(Workspace::load(dir.path()), w);

        fs::write(dir.path().join(FILE_NAME), "{ not json").unwrap();
        assert_eq!(Workspace::load(dir.path()), Workspace::default());
    }

    #[test]
    fn forgets_an_active_repository_that_is_no_longer_listed() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), r#"{"repositories":[{"path":"/a"}],"active":"/zzz"}"#).unwrap();
        assert_eq!(Workspace::load(dir.path()).active, None);
    }

    #[test]
    fn adds_once_and_removes_like_browser_tabs() {
        let mut w = workspace(&["/a", "/b", "/c"]);
        assert!(!w.add("/b".into()));
        w.active = Some("/b".into());
        w.remove(Path::new("/b"));
        assert_eq!(w.active.as_deref(), Some(Path::new("/c")));
        w.remove(Path::new("/c"));
        assert_eq!(w.active.as_deref(), Some(Path::new("/a")));
        w.remove(Path::new("/a"));
        assert_eq!(w.active, None);
        assert!(w.repositories.is_empty());
    }

    #[test]
    fn keeps_the_colour_of_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = workspace(&["/a", "/b"]);
        w.set_color(Path::new("/b"), Some("#12ab34".into()));
        w.save(dir.path()).unwrap();
        let text = fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        // No colour: nothing written, so older files and newer ones read the same.
        assert_eq!(text.matches("color").count(), 1);
        assert_eq!(Workspace::load(dir.path()).repositories[1].color.as_deref(), Some("#12ab34"));
        w.set_color(Path::new("/b"), None);
        assert_eq!(w.repositories[1].color, None);
    }

    #[test]
    fn reorders_tabs() {
        let mut w = workspace(&["/a", "/b", "/c"]);
        w.reorder(Path::new("/a"), 9);
        assert_eq!(names(&w), ["/b", "/c", "/a"]);
        w.reorder(Path::new("/a"), 0);
        assert_eq!(names(&w), ["/a", "/b", "/c"]);
    }
}

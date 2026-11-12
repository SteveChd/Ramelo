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
    /// The tab was closed: the repository stays in the overview, from where it can be opened again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub closed: bool,
    /// The tab is pinned: it stays at the start of the tabs, always in view.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    /// Section of the overview the repository is filed under; `None`: with the others, at the end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
}

/// A group of repositories in the overview (a team, a product…), folded or not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub name: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub collapsed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspace {
    pub repositories: Vec<RepoEntry>,
    /// Repository shown at startup; `None` shows the overview of all repositories.
    pub active: Option<PathBuf>,
    /// Sections of the overview, in the user's order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<Section>,
    /// The repositories in no section are folded (they only form a group when sections exist).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub others_collapsed: bool,
}

impl Workspace {
    /// Reads the workspace; a missing or unreadable file gives an empty workspace.
    pub fn load(dir: &Path) -> Self {
        let mut workspace: Self = fs::read_to_string(dir.join(FILE_NAME))
            .ok()
            .and_then(|text| serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok())
            .unwrap_or_default();
        workspace.tidy_sections();
        if workspace.active.as_ref().is_some_and(|a| !workspace.is_open(a)) {
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

    /// The repository is in the workspace and has a tab.
    pub fn is_open(&self, path: &Path) -> bool {
        self.repositories.iter().any(|r| r.path == path && !r.closed)
    }

    /// Adds a repository at the end of the tabs; returns false if it was already there (its tab is
    /// opened again if it was closed).
    pub fn add(&mut self, path: PathBuf) -> bool {
        if self.contains(&path) {
            self.open(&path);
            return false;
        }
        self.repositories.push(RepoEntry { path, color: None, closed: false, pinned: false, section: None });
        true
    }

    /// Gives a repository its tab back.
    pub fn open(&mut self, path: &Path) {
        if let Some(entry) = self.repositories.iter_mut().find(|r| r.path == path) {
            entry.closed = false;
        }
    }

    /// Closes the tab of a repository; it stays in the workspace and the overview. When it was the
    /// active one, the neighbouring tab becomes active, as in a browser.
    pub fn close(&mut self, path: &Path) {
        let Some(index) = self.repositories.iter().position(|r| r.path == path) else { return };
        self.repositories[index].closed = true;
        self.repositories[index].pinned = false;
        if self.active.as_deref() == Some(path) {
            self.active = self.open_neighbour(index);
        }
    }

    /// Closes several tabs at once; the active one, if closed, gives way to an open neighbour.
    pub fn close_many(&mut self, paths: &[PathBuf]) {
        for path in paths {
            self.close(path);
        }
    }

    /// Pins a tab (opening it if it was closed) or unpins it. Pinned tabs come first: the tab moves to
    /// the end of the pinned ones, or, when unpinned, to the start of the others.
    pub fn set_pinned(&mut self, path: &Path, pinned: bool) {
        let Some(from) = self.repositories.iter().position(|r| r.path == path) else { return };
        let mut entry = self.repositories.remove(from);
        entry.pinned = pinned;
        if pinned {
            entry.closed = false;
        }
        let at = self.repositories.iter().take_while(|r| r.pinned).count();
        self.repositories.insert(at, entry);
    }

    /// The open tab after `index`, or else the one before it.
    fn open_neighbour(&self, index: usize) -> Option<PathBuf> {
        let after = self.repositories.iter().skip(index + 1).find(|r| !r.closed);
        let before = self.repositories.iter().take(index).rev().find(|r| !r.closed);
        after.or(before).map(|r| r.path.clone())
    }

    /// Removes a repository from the workspace (the folder on disk is not touched). When it was the
    /// active one, its neighbour becomes active, as when closing a browser tab.
    pub fn remove(&mut self, path: &Path) {
        let Some(index) = self.repositories.iter().position(|r| r.path == path) else { return };
        if self.active.as_deref() == Some(path) {
            self.active = self.open_neighbour(index);
        }
        self.repositories.remove(index);
    }

    /// Removes several repositories at once (all of them, or those the overview shows).
    pub fn remove_many(&mut self, paths: &[PathBuf]) {
        for path in paths {
            self.remove(path);
        }
    }

    /// The tab of `from` shows `to` instead (another worktree of the same repository): it keeps its
    /// place, colour, pin and section. When `to` already had an entry of its own, that one goes, so
    /// that a folder is never listed twice. Returns false when `from` is not in the workspace.
    pub fn retarget(&mut self, from: &Path, to: PathBuf) -> bool {
        if from == to {
            return self.contains(from);
        }
        if !self.contains(from) {
            return false;
        }
        self.repositories.retain(|r| r.path != to);
        let entry = self.repositories.iter_mut().find(|r| r.path == from).expect("checked above");
        entry.path = to.clone();
        entry.closed = false;
        if self.active.as_deref() == Some(from) {
            self.active = Some(to);
        }
        true
    }

    /// Sets the colour of a repository (`None`: back to the automatic one).
    pub fn set_color(&mut self, path: &Path, color: Option<String>) {
        if let Some(entry) = self.repositories.iter_mut().find(|r| r.path == path) {
            entry.color = color;
        }
    }

    /// Drops sections listed twice or without a name, and files under no section the repositories
    /// whose section is no longer listed (a file edited by hand).
    fn tidy_sections(&mut self) {
        let mut seen = std::collections::HashSet::new();
        self.sections.retain(|s| !s.name.trim().is_empty() && seen.insert(s.name.clone()));
        for entry in &mut self.repositories {
            if entry.section.as_ref().is_some_and(|name| !seen.contains(name)) {
                entry.section = None;
            }
        }
    }

    fn has_section(&self, name: &str) -> bool {
        self.sections.iter().any(|s| s.name == name)
    }

    /// Adds an empty section at the end; returns false when the name is empty or already taken.
    pub fn add_section(&mut self, name: &str) -> bool {
        let name = name.trim();
        if name.is_empty() || self.has_section(name) {
            return false;
        }
        self.sections.push(Section { name: name.to_owned(), collapsed: false });
        true
    }

    /// Renames a section, its repositories following; returns false when the new name is empty or
    /// taken by another section.
    pub fn rename_section(&mut self, old: &str, new: &str) -> bool {
        let new = new.trim();
        if new.is_empty() || (new != old && self.has_section(new)) {
            return false;
        }
        let Some(section) = self.sections.iter_mut().find(|s| s.name == old) else { return false };
        section.name = new.to_owned();
        for entry in self.repositories.iter_mut().filter(|r| r.section.as_deref() == Some(old)) {
            entry.section = Some(new.to_owned());
        }
        true
    }

    /// Removes a section; its repositories go back with those in no section.
    pub fn remove_section(&mut self, name: &str) {
        self.sections.retain(|s| s.name != name);
        for entry in self.repositories.iter_mut().filter(|r| r.section.as_deref() == Some(name)) {
            entry.section = None;
        }
    }

    /// Moves a section to `index` (clamped to the number of sections).
    pub fn move_section(&mut self, name: &str, index: usize) {
        let Some(from) = self.sections.iter().position(|s| s.name == name) else { return };
        let section = self.sections.remove(from);
        self.sections.insert(index.min(self.sections.len()), section);
    }

    /// Folds or unfolds a section; `None` is the group of repositories in no section.
    pub fn set_section_collapsed(&mut self, name: Option<&str>, collapsed: bool) {
        match name {
            None => self.others_collapsed = collapsed,
            Some(name) => {
                if let Some(section) = self.sections.iter_mut().find(|s| s.name == name) {
                    section.collapsed = collapsed;
                }
            }
        }
    }

    /// Files repositories under a section, created at the end when it does not exist yet (`None`:
    /// under no section).
    pub fn set_section(&mut self, paths: &[PathBuf], section: Option<&str>) {
        let section = section.map(str::trim).filter(|s| !s.is_empty());
        if let Some(name) = section {
            self.add_section(name);
        }
        for entry in self.repositories.iter_mut().filter(|r| paths.contains(&r.path)) {
            entry.section = section.map(str::to_owned);
        }
    }

    /// Moves a tab to `index` (clamped to the number of tabs), staying among the pinned tabs or
    /// among the others.
    pub fn reorder(&mut self, path: &Path, index: usize) {
        let Some(from) = self.repositories.iter().position(|r| r.path == path) else { return };
        let entry = self.repositories.remove(from);
        let pinned = self.repositories.iter().take_while(|r| r.pinned).count();
        let index = if entry.pinned { index.min(pinned) } else { index.clamp(pinned, self.repositories.len()) };
        self.repositories.insert(index, entry);
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
    fn closes_a_tab_without_forgetting_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = workspace(&["/a", "/b", "/c"]);
        w.active = Some("/b".into());
        w.close(Path::new("/b"));
        assert_eq!(names(&w), ["/a", "/b", "/c"]);
        assert_eq!(w.active.as_deref(), Some(Path::new("/c")));
        w.close(Path::new("/c"));
        assert_eq!(w.active.as_deref(), Some(Path::new("/a")));
        w.save(dir.path()).unwrap();
        let loaded = Workspace::load(dir.path());
        assert!(!loaded.is_open(Path::new("/b")) && loaded.contains(Path::new("/b")));
        // Adding it again, or opening it, gives it its tab back.
        assert!(!w.add("/b".into()));
        assert!(w.is_open(Path::new("/b")));
        w.close(Path::new("/a"));
        w.close(Path::new("/b"));
        assert_eq!(w.active, None);
        w.open(Path::new("/c"));
        assert!(w.is_open(Path::new("/c")));
    }

    #[test]
    fn pins_tabs_first_and_closes_several() {
        let mut w = workspace(&["/a", "/b", "/c", "/d"]);
        let order = |w: &Workspace| w.repositories.iter().map(|r| r.path.to_str().unwrap().to_owned()).collect::<Vec<_>>();
        w.set_pinned(Path::new("/c"), true);
        w.set_pinned(Path::new("/d"), true);
        assert_eq!(order(&w), ["/c", "/d", "/a", "/b"]);
        // A pinned tab stays among the pinned ones, another one after them.
        w.reorder(Path::new("/d"), 3);
        assert_eq!(order(&w), ["/c", "/d", "/a", "/b"]);
        w.reorder(Path::new("/b"), 0);
        assert_eq!(order(&w), ["/c", "/d", "/b", "/a"]);
        w.set_pinned(Path::new("/c"), false);
        assert_eq!(order(&w), ["/d", "/c", "/b", "/a"]);

        w.active = Some(PathBuf::from("/b"));
        w.close_many(&[PathBuf::from("/b"), PathBuf::from("/c"), PathBuf::from("/d")]);
        assert_eq!(w.active.as_deref(), Some(Path::new("/a")));
        assert!(w.repositories.iter().all(|r| !r.pinned));
        // Pinning a closed tab opens it again.
        w.set_pinned(Path::new("/b"), true);
        assert!(w.is_open(Path::new("/b")));
    }

    #[test]
    fn removes_several_repositories() {
        let mut w = workspace(&["/a", "/b", "/c"]);
        w.active = Some(PathBuf::from("/b"));
        w.remove_many(&[PathBuf::from("/a"), PathBuf::from("/b")]);
        assert_eq!(w.repositories.len(), 1);
        assert_eq!(w.active.as_deref(), Some(Path::new("/c")));
        w.remove_many(&[PathBuf::from("/c")]);
        assert!(w.repositories.is_empty() && w.active.is_none());
    }

    #[test]
    fn does_not_start_on_a_closed_tab() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), r#"{"repositories":[{"path":"/a","closed":true}],"active":"/a"}"#).unwrap();
        assert_eq!(Workspace::load(dir.path()).active, None);
    }

    #[test]
    fn files_repositories_under_sections() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = workspace(&["/a", "/b", "/c"]);
        let sections = |w: &Workspace| w.sections.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        let of = |w: &Workspace, i: usize| w.repositories[i].section.clone();
        assert!(w.add_section("Team A"));
        assert!(!w.add_section(" Team A ") && !w.add_section("  "));
        // Filing under a section that does not exist creates it.
        w.set_section(&[PathBuf::from("/a"), PathBuf::from("/c")], Some("Team B"));
        assert_eq!(sections(&w), ["Team A", "Team B"]);
        assert_eq!(of(&w, 2).as_deref(), Some("Team B"));

        assert!(!w.rename_section("Team B", "Team A"));
        assert!(w.rename_section("Team B", "Platform"));
        assert_eq!(of(&w, 0).as_deref(), Some("Platform"));
        w.move_section("Platform", 0);
        assert_eq!(sections(&w), ["Platform", "Team A"]);
        w.set_section_collapsed(Some("Platform"), true);
        w.set_section_collapsed(None, true);

        w.save(dir.path()).unwrap();
        assert_eq!(Workspace::load(dir.path()), w);

        w.remove_section("Platform");
        assert_eq!(sections(&w), ["Team A"]);
        assert!(w.repositories.iter().all(|r| r.section.is_none()));
    }

    #[test]
    fn forgets_sections_that_are_not_listed() {
        let dir = tempfile::tempdir().unwrap();
        let text = r#"{"repositories":[{"path":"/a","section":"Gone"},{"path":"/b","section":"Kept"}],"sections":[{"name":"Kept"},{"name":"Kept"},{"name":""}]}"#;
        fs::write(dir.path().join(FILE_NAME), text).unwrap();
        let w = Workspace::load(dir.path());
        assert_eq!(w.sections.len(), 1);
        assert_eq!(w.repositories[0].section, None);
        assert_eq!(w.repositories[1].section.as_deref(), Some("Kept"));
    }

    #[test]
    fn reorders_tabs() {
        let mut w = workspace(&["/a", "/b", "/c"]);
        w.reorder(Path::new("/a"), 9);
        assert_eq!(names(&w), ["/b", "/c", "/a"]);
        w.reorder(Path::new("/a"), 0);
        assert_eq!(names(&w), ["/a", "/b", "/c"]);
    }

    #[test]
    fn a_tab_follows_another_worktree() {
        let mut w = workspace(&["/a", "/b", "/a-wt"]);
        w.set_color(Path::new("/a"), Some("#123456".into()));
        w.active = Some(PathBuf::from("/a"));
        // The worktree had a tab of its own: it goes, the tab of /a takes its folder.
        assert!(w.retarget(Path::new("/a"), PathBuf::from("/a-wt")));
        assert_eq!(names(&w), ["/a-wt", "/b"]);
        assert_eq!(w.repositories[0].color.as_deref(), Some("#123456"));
        assert_eq!(w.active.as_deref(), Some(Path::new("/a-wt")));
        // Back to the main folder, which was in no tab.
        assert!(w.retarget(Path::new("/a-wt"), PathBuf::from("/a")));
        assert_eq!(names(&w), ["/a", "/b"]);
        assert!(!w.retarget(Path::new("/nowhere"), PathBuf::from("/x")));
    }
}

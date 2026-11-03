//! Pull requests already read from their service, kept on disk so that one opened again shows at
//! once, even after a restart, and so that the application does not hold them in memory. Each
//! repository has a folder of its own: per pull request, its conversation and its changes in two
//! files, and in `index.json` what tells whether they are still current (when they were read, the
//! update time and the last commit of the pull request then). Only open pull requests are kept.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{atomic, StorageError};

const DIR_NAME: &str = "pull-cache";
const INDEX: &str = "index.json";

/// What is known of one pull request kept.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPull {
    pub number: u64,
    /// When the conversation was read (milliseconds since 1970), if it is kept.
    pub view_at: Option<u64>,
    /// The update time of the pull request in that conversation.
    pub updated: Option<i64>,
    pub head_oid: Option<String>,
    /// When the changes were read, if they are kept.
    pub changes_at: Option<u64>,
    /// The last commit of those changes.
    pub changes_head: Option<String>,
}

/// One part kept, with when it was read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cached {
    pub at: u64,
    pub data: Value,
}

#[derive(Debug, Clone, Copy)]
enum Part {
    View,
    Changes,
}

impl Part {
    fn file(self, number: u64) -> String {
        match self {
            Self::View => format!("{number}.view.json"),
            Self::Changes => format!("{number}.changes.json"),
        }
    }
}

pub struct PullCache {
    dir: PathBuf,
    /// Held while an index is read and written, so that two readings at the same time keep both.
    lock: Mutex<()>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// A stable name for the folder of a repository (FNV-1a of its path).
fn folder_name(repo: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in repo.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

impl PullCache {
    /// The cache in the data folder of the application.
    pub fn new(data_dir: &Path) -> Self {
        Self { dir: data_dir.join(DIR_NAME), lock: Mutex::new(()) }
    }

    fn repo_dir(&self, repo: &Path) -> PathBuf {
        self.dir.join(folder_name(repo))
    }

    fn read_index(dir: &Path) -> BTreeMap<u64, CachedPull> {
        fs::read_to_string(dir.join(INDEX)).ok().and_then(|text| serde_json::from_str::<Vec<CachedPull>>(&text).ok()).map_or_else(
            BTreeMap::new,
            |list| list.into_iter().map(|p| (p.number, p)).collect(),
        )
    }

    fn write_index(dir: &Path, index: &BTreeMap<u64, CachedPull>) -> Result<(), StorageError> {
        let path = dir.join(INDEX);
        if index.is_empty() {
            // Nothing kept for this repository any more: its folder goes.
            let _ = fs::remove_dir_all(dir);
            return Ok(());
        }
        let list: Vec<&CachedPull> = index.values().collect();
        let bytes = serde_json::to_vec(&list).map_err(|source| StorageError::Format { path: path.clone(), source })?;
        atomic::write(&path, &bytes)
    }

    /// Changes the index of `repo` under the lock.
    fn edit<T>(&self, repo: &Path, change: impl FnOnce(&Path, &mut BTreeMap<u64, CachedPull>) -> T) -> Result<T, StorageError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let dir = self.repo_dir(repo);
        let mut index = Self::read_index(&dir);
        let result = change(&dir, &mut index);
        Self::write_index(&dir, &index)?;
        Ok(result)
    }

    /// What is kept for the pull requests of `repo`.
    pub fn index(&self, repo: &Path) -> Vec<CachedPull> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        Self::read_index(&self.repo_dir(repo)).into_values().collect()
    }

    fn read(&self, repo: &Path, number: u64, part: Part) -> Option<Cached> {
        let entry = self.index(repo).into_iter().find(|p| p.number == number)?;
        let at = match part {
            Part::View => entry.view_at,
            Part::Changes => entry.changes_at,
        }?;
        let text = fs::read_to_string(self.repo_dir(repo).join(part.file(number))).ok()?;
        Some(Cached { at, data: serde_json::from_str(&text).ok()? })
    }

    /// The conversation kept, if any.
    pub fn view(&self, repo: &Path, number: u64) -> Option<Cached> {
        self.read(repo, number, Part::View)
    }

    /// The changes kept, if any.
    pub fn changes(&self, repo: &Path, number: u64) -> Option<Cached> {
        self.read(repo, number, Part::Changes)
    }

    fn write(&self, repo: &Path, number: u64, part: Part, data: &impl Serialize, mark: impl FnOnce(&mut CachedPull, u64)) -> Result<(), StorageError> {
        self.edit(repo, |dir, index| {
            let path = dir.join(part.file(number));
            let bytes = serde_json::to_vec(data).map_err(|source| StorageError::Format { path: path.clone(), source })?;
            atomic::write(&path, &bytes)?;
            mark(index.entry(number).or_insert_with(|| CachedPull { number, ..CachedPull::default() }), now());
            Ok(())
        })?
    }

    /// Keeps the conversation of an open pull request, with its update time and last commit.
    pub fn put_view(&self, repo: &Path, number: u64, view: &impl Serialize, updated: Option<i64>, head_oid: Option<String>) -> Result<(), StorageError> {
        self.write(repo, number, Part::View, view, |entry, at| {
            entry.view_at = Some(at);
            entry.updated = updated;
            entry.head_oid = head_oid;
        })
    }

    /// Keeps the changes of a pull request, up to the commit `head`.
    pub fn put_changes(&self, repo: &Path, number: u64, changes: &impl Serialize, head: &str) -> Result<(), StorageError> {
        self.write(repo, number, Part::Changes, changes, |entry, at| {
            entry.changes_at = Some(at);
            entry.changes_head = Some(head.to_owned());
        })
    }

    /// Forgets one pull request (merged or closed).
    pub fn forget(&self, repo: &Path, number: u64) -> Result<(), StorageError> {
        self.retain(repo, |n| n != number)
    }

    /// Forgets the pull requests of `repo` that are not in `open`.
    pub fn keep_only(&self, repo: &Path, open: &[u64]) -> Result<(), StorageError> {
        self.retain(repo, |n| open.contains(&n))
    }

    fn retain(&self, repo: &Path, keep: impl Fn(u64) -> bool) -> Result<(), StorageError> {
        self.edit(repo, |dir, index| {
            index.retain(|&number, _| {
                if keep(number) {
                    return true;
                }
                for part in [Part::View, Part::Changes] {
                    let _ = fs::remove_file(dir.join(part.file(number)));
                }
                false
            });
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_reads_and_forgets() {
        let data = tempfile::tempdir().unwrap();
        let cache = PullCache::new(data.path());
        let repo = Path::new("/work/tool");
        assert!(cache.view(repo, 4).is_none());
        cache.put_view(repo, 4, &serde_json::json!({ "title": "Four" }), Some(10), Some("abc".into())).unwrap();
        cache.put_changes(repo, 4, &serde_json::json!({ "head": "abc" }), "abc").unwrap();
        cache.put_view(repo, 5, &serde_json::json!({ "title": "Five" }), None, None).unwrap();
        assert_eq!(cache.view(repo, 4).unwrap().data["title"], "Four");
        assert_eq!(cache.changes(repo, 4).unwrap().data["head"], "abc");
        assert!(cache.changes(repo, 5).is_none());
        let index = cache.index(repo);
        assert_eq!(index.len(), 2);
        assert_eq!(index[0].changes_head.as_deref(), Some("abc"));

        // #4 merged: only #5 is still open.
        cache.keep_only(repo, &[5]).unwrap();
        assert!(cache.view(repo, 4).is_none());
        let dir = cache.repo_dir(repo);
        assert!(!dir.join("4.view.json").exists() && !dir.join("4.changes.json").exists());
        cache.forget(repo, 5).unwrap();
        assert!(!dir.exists());
        // Another repository has a folder of its own.
        assert_ne!(folder_name(repo), folder_name(Path::new("/work/other")));
    }
}

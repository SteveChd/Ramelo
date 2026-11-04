//! State shared by the commands: the workspace, the last known state of each repository, the
//! accounts on hosting services and the language of the interface.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::thread;

use ramelo_core::{Git, RepoSummary};
use ramelo_storage::{Accounts, PullCache, Workspace};

use crate::error::{CommandError, CommandResult};
use crate::snapshot::Snapshot;

/// What was last read from a repository: its summary, or why it could not be read (folder moved,
/// git missing…).
pub type RepoState = Result<RepoSummary, CommandError>;

pub struct AppState {
    data_dir: PathBuf,
    pub git: Git,
    workspace: Mutex<Workspace>,
    accounts: Mutex<Accounts>,
    states: Mutex<HashMap<PathBuf, RepoState>>,
    language: Mutex<String>,
    /// Set to stop the clone in progress.
    pub clone_cancelled: AtomicBool,
    /// Pull requests already read, on disk.
    pub pull_cache: PullCache,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self::with_git(data_dir, Git::default())
    }

    pub fn with_git(data_dir: PathBuf, git: Git) -> Self {
        let workspace = Workspace::load(&data_dir);
        let accounts = Accounts::load(&data_dir);
        Self {
            pull_cache: PullCache::new(&data_dir),
            data_dir,
            git,
            workspace: Mutex::new(workspace),
            accounts: Mutex::new(accounts),
            states: Mutex::new(HashMap::new()),
            language: Mutex::new("en".to_owned()),
            clone_cancelled: AtomicBool::new(false),
        }
    }

    /// The data folder of the application.
    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    /// Exclusive access to the workspace; a lock poisoned by a panic stays usable.
    pub fn workspace(&self) -> MutexGuard<'_, Workspace> {
        self.workspace.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The accounts on hosting services.
    pub fn accounts(&self) -> MutexGuard<'_, Accounts> {
        self.accounts.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Applies `change` to the accounts and saves them.
    pub fn edit_accounts<T>(&self, change: impl FnOnce(&mut Accounts) -> T) -> CommandResult<T> {
        let mut accounts = self.accounts();
        let result = change(&mut accounts);
        accounts.save(&self.data_dir)?;
        Ok(result)
    }

    fn states(&self) -> MutexGuard<'_, HashMap<PathBuf, RepoState>> {
        self.states.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Applies `change` to the workspace and saves it.
    pub fn edit_workspace<T>(&self, change: impl FnOnce(&mut Workspace) -> T) -> CommandResult<T> {
        let mut workspace = self.workspace();
        let result = change(&mut workspace);
        workspace.save(&self.data_dir)?;
        Ok(result)
    }

    /// Reads again the state of `paths` (several repositories at once) and remembers it.
    pub fn refresh(&self, paths: &[PathBuf]) {
        let results = read_all(&self.git, paths);
        let mut states = self.states();
        for (path, state) in paths.iter().zip(results) {
            states.insert(path.clone(), state);
        }
    }

    /// Reads the repositories of the workspace that were never read yet.
    pub fn refresh_unknown(&self) {
        let paths = self.repository_paths();
        let unknown: Vec<PathBuf> = {
            let states = self.states();
            paths.into_iter().filter(|p| !states.contains_key(p)).collect()
        };
        self.refresh(&unknown);
    }

    pub fn repository_paths(&self) -> Vec<PathBuf> {
        self.workspace().repositories.iter().map(|r| r.path.clone()).collect()
    }

    pub fn forget(&self, path: &Path) {
        // Its pull requests kept on disk go too.
        let _ = self.pull_cache.keep_only(path, &[]);
        self.states().remove(path);
    }

    /// What the interface shows: the workspace and the last known state of each repository.
    pub fn snapshot(&self) -> Snapshot {
        let workspace = self.workspace().clone();
        let states = self.states();
        Snapshot::new(&workspace, &states)
    }

    pub fn language(&self) -> String {
        self.language.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_language(&self, language: &str) {
        *self.language.lock().unwrap_or_else(|e| e.into_inner()) = language.to_owned();
    }
}

/// Reads one repository.
fn read_one(git: &Git, path: &Path) -> RepoState {
    let location = ramelo_core::open(git, path)?;
    Ok(ramelo_core::summary(git, &location)?)
}

/// Reads several repositories in parallel: each one starts a few git processes, which mostly wait for
/// the disk, so a small pool of threads makes the overview of a large workspace much faster.
fn read_all(git: &Git, paths: &[PathBuf]) -> Vec<RepoState> {
    let workers = thread::available_parallelism().map_or(4, |n| n.get() * 2).min(paths.len().max(1));
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<RepoState>>> = Mutex::new(vec![None; paths.len()]);
    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(path) = paths.get(index) else { break };
                let state = read_one(git, path);
                results.lock().unwrap_or_else(|e| e.into_inner())[index] = Some(state);
            });
        }
    });
    results.into_inner().unwrap_or_else(|e| e.into_inner()).into_iter().map(Option::unwrap).collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn init(dir: &Path) {
        let out = Git::default().raw(dir, &["init", "-q"]).unwrap();
        assert!(out.status.success());
    }

    #[test]
    fn reads_every_repository_and_remembers_failures() {
        let data = tempfile::tempdir().unwrap();
        let repos = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for i in 0..6 {
            let path = repos.path().join(format!("r{i}"));
            fs::create_dir_all(&path).unwrap();
            init(&path);
            paths.push(path);
        }
        let gone = repos.path().join("gone");
        paths.push(gone.clone());

        let state = AppState::new(data.path().to_path_buf());
        state.edit_workspace(|w| paths.iter().for_each(|p| { w.add(p.clone()); })).unwrap();
        state.refresh_unknown();

        let snapshot = state.snapshot();
        assert_eq!(snapshot.repositories.len(), 7);
        assert!(snapshot.repositories[..6].iter().all(|r| r.summary.is_some()));
        let missing = &snapshot.repositories[6];
        assert_eq!(missing.error.as_ref().map(|e| serde_json::to_value(e).unwrap()["code"].clone()), Some("path_missing".into()));

        // The workspace was saved and comes back at the next launch.
        let again = AppState::new(data.path().to_path_buf());
        assert_eq!(again.repository_paths(), paths);
    }
}

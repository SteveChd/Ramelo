//! New versions of Ramelo: checked on the releases of GitHub, then downloaded and installed when the
//! user agrees. The installers are signed when they are built; an update whose signature does not
//! match the key in `tauri.conf.json` is refused.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{CommandError, CommandResult};

/// Page of the releases, for the systems where Ramelo cannot replace itself.
pub const RELEASES_PAGE: &str = "https://github.com/SteveChd/Ramelo/releases/latest";

/// The update found by the last check, kept for its installation.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    /// What the release says about itself (Markdown), if anything.
    pub notes: Option<String>,
    /// Publication, in seconds since 1970.
    pub date: Option<i64>,
    /// False where the application cannot replace itself (on Linux, outside an AppImage): the user
    /// downloads the new version from `page`.
    pub can_install: bool,
    pub page: String,
}

fn failed(code: &'static str, error: impl ToString) -> CommandError {
    CommandError::new(code, None, error.to_string())
}

/// Ramelo can install an update itself: always on Windows and macOS, on Linux only when it runs as an
/// AppImage (a .deb or .rpm belongs to the package manager).
fn can_install() -> bool {
    !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some()
}

/// Looks for a version newer than this one; `None` when this one is the latest.
#[tauri::command]
pub async fn check_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> CommandResult<Option<UpdateInfo>> {
    let updater = app.updater().map_err(|e| failed("update_check_failed", e))?;
    let update = updater.check().await.map_err(|e| failed("update_check_failed", e))?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        date: u.date.map(|d| d.unix_timestamp()),
        can_install: can_install(),
        page: RELEASES_PAGE.to_owned(),
    });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

/// Where the download is: bytes received, and the size when the server tells it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    /// The download is over: the installer runs.
    pub installing: bool,
}

/// Downloads and installs the update found by the last check, then starts the new version.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>, progress: Channel<UpdateProgress>) -> CommandResult<()> {
    let update = pending.0.lock().unwrap().take()
        .ok_or_else(|| CommandError::new("update_missing", None, "no update to install: check again"))?;
    let downloaded = AtomicU64::new(0);
    update
        .download_and_install(
            |chunk, total| {
                let downloaded = downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                let _ = progress.send(UpdateProgress { downloaded, total, installing: false });
            },
            || {
                let downloaded = downloaded.load(Ordering::Relaxed);
                let _ = progress.send(UpdateProgress { downloaded, total: None, installing: true });
            },
        )
        .await
        .map_err(|e| failed("update_install_failed", e))?;
    app.restart();
}

//! Servers that ssh does not know yet: their keys, shown to the user, and trusting them.

use std::path::Path;

use ramelo_core::{GitError, HostKey};
use tauri::State;

use crate::error::CommandResult;
use crate::state::AppState;

/// Names the server of a failure on an unknown server when ssh did not: the ssh remote of the
/// repository (« origin » first).
pub(crate) fn name_host(state: &AppState, error: GitError, root: &Path) -> GitError {
    match error {
        GitError::HostUnknown(host) if host.is_empty() => {
            let mut urls = ramelo_core::remote_urls(&state.git, root).unwrap_or_default();
            urls.sort_by_key(|(name, _)| name != "origin");
            GitError::HostUnknown(urls.iter().find_map(|(_, url)| ramelo_core::ssh_host(url)).unwrap_or_default())
        }
        other => other,
    }
}

/// Same for an address (a clone).
pub(crate) fn name_host_of(error: GitError, url: &str) -> GitError {
    match error {
        GitError::HostUnknown(host) if host.is_empty() => GitError::HostUnknown(ramelo_core::ssh_host(url).unwrap_or_default()),
        other => other,
    }
}

/// The keys of a server, with their fingerprints, read from it.
#[tauri::command]
pub async fn ssh_host_keys(state: State<'_, AppState>, host: String) -> CommandResult<Vec<HostKey>> {
    Ok(ramelo_core::scan_host_keys(&state.git, &host)?)
}

/// Adds the keys of a server that the user accepted (by their fingerprints) to the known hosts.
#[tauri::command]
pub async fn trust_ssh_host(state: State<'_, AppState>, host: String, fingerprints: Vec<String>) -> CommandResult<usize> {
    Ok(ramelo_core::trust_host(&state.git, &host, &fingerprints)?)
}

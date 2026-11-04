//! Settings sent by the interface.

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

/// Language of the interface (« en » or « fr »), used for the native dialogs.
#[tauri::command]
pub fn set_language(state: State<'_, AppState>, language: String) {
    state.set_language(&language);
}

/// Shows the main window, created hidden: the interface calls it once the splash screen is drawn, to
/// avoid a white flash at launch.
#[tauri::command]
pub fn show_window(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// What the « About » window tells: the version of the application and what it runs on.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    pub version: String,
    pub authors: String,
    pub license: String,
    /// The version of git found, if any.
    pub git: Option<String>,
    pub webview: Option<String>,
    pub tauri: String,
    pub os: String,
    pub arch: String,
    /// Where the application keeps its settings, accounts and cache.
    pub data_dir: String,
}

#[tauri::command]
pub async fn about(state: State<'_, AppState>) -> Result<About, ()> {
    Ok(About {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        authors: env!("CARGO_PKG_AUTHORS").replace(':', ", "),
        license: env!("CARGO_PKG_LICENSE").to_owned(),
        git: state.git.version().ok(),
        webview: tauri::webview_version().ok(),
        tauri: tauri::VERSION.to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        data_dir: state.data_dir().display().to_string(),
    })
}

/// Tells the user something happened (a new pull request, a new comment) while they may be elsewhere:
/// a notification of the system, and the window asks for attention (the taskbar button flashes)
/// when it is not in front.
#[tauri::command]
pub fn notify(app: tauri::AppHandle, window: tauri::WebviewWindow, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
    if !window.is_focused().unwrap_or(true) {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

//! Settings sent by the interface.

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

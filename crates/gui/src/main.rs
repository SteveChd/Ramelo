// No extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! GitController, desktop application: a thin layer that exposes the core and the storage to the
//! interface.

mod commands;
mod error;
mod snapshot;
mod state;

use tauri::Manager;

use crate::state::AppState;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(AppState::new(data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace::startup,
            commands::workspace::refresh,
            commands::workspace::pick_folder,
            commands::workspace::add_repositories,
            commands::workspace::remove_repository,
            commands::workspace::select_repository,
            commands::workspace::reorder_repository,
            commands::workspace::open_folder,
            commands::settings::set_language,
            commands::settings::show_window,
        ])
        .run(tauri::generate_context!())
        .expect("cannot start GitController");
}

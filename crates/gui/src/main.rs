// No extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Ramelo, desktop application: a thin layer that exposes the core and the storage to the
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
            migrate_legacy_data(&data_dir);
            app.manage(AppState::new(data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace::startup,
            commands::workspace::refresh,
            commands::workspace::pick_folder,
            commands::workspace::add_repositories,
            commands::workspace::remove_repository,
            commands::workspace::close_repository,
            commands::workspace::select_repository,
            commands::workspace::reorder_repository,
            commands::workspace::set_repository_color,
            commands::workspace::open_folder,
            commands::repo::history,
            commands::repo::rewrite_info,
            commands::repo::reword_commit,
            commands::repo::edit_commit_file,
            commands::repo::commit_details,
            commands::repo::commit_file_diff,
            commands::repo::file_diff,
            commands::repo::search_commits,
            commands::repo::file_versions,
            commands::repo::stage,
            commands::repo::stage_all,
            commands::repo::unstage,
            commands::repo::unstage_all,
            commands::repo::discard,
            commands::repo::apply_hunk,
            commands::repo::commit,
            commands::repo::last_message,
            commands::repo::branches,
            commands::repo::switch_branch,
            commands::repo::create_branch,
            commands::repo::delete_branch,
            commands::repo::fetch,
            commands::repo::pull,
            commands::repo::push,
            commands::settings::set_language,
            commands::settings::show_window,
        ])
        .run(tauri::generate_context!())
        .expect("cannot start Ramelo");
}

/// The application was called GitController before: brings its workspace over on the first start
/// under the new name, so the repositories the user registered are not lost.
fn migrate_legacy_data(data_dir: &std::path::Path) {
    const FILE: &str = "workspace.json";
    let Some(legacy) = data_dir.parent().map(|parent| parent.join("fr.gitcontroller.app").join(FILE)) else {
        return;
    };
    let target = data_dir.join(FILE);
    if target.exists() || !legacy.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(data_dir).and_then(|()| std::fs::copy(&legacy, &target));
}

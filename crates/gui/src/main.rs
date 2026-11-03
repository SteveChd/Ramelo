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
            commands::accounts::list_accounts,
            commands::ssh::ssh_host_keys,
            commands::ssh::trust_ssh_host,
            commands::accounts::add_account,
            commands::accounts::check_account,
            commands::accounts::remove_account,
            commands::accounts::token_page,
            commands::accounts::open_url,
            commands::accounts::search_repositories,
            commands::accounts::repository_readme,
            commands::pulls::repository_hosting,
            commands::pulls::pull_requests,
            commands::pulls::pull_request,
            commands::pulls::pull_request_changes,
            commands::pulls::pull_cache_index,
            commands::pulls::cached_pull_request,
            commands::pulls::cached_pull_request_changes,
            commands::pulls::range_file_diff,
            commands::pulls::comment_pull_request,
            commands::pulls::comment_pull_request_line,
            commands::pulls::merge_pull_request,
            commands::pulls::close_pull_request,
            commands::pulls::create_pull_request,
            commands::workspace::startup,
            commands::workspace::refresh,
            commands::workspace::pick_folder,
            commands::workspace::pick_clone_folder,
            commands::workspace::clone_repository,
            commands::workspace::cancel_clone,
            commands::workspace::add_repositories,
            commands::workspace::remove_repository,
            commands::workspace::remove_repositories,
            commands::workspace::close_repository,
            commands::workspace::close_repositories,
            commands::workspace::set_repository_pinned,
            commands::workspace::select_repository,
            commands::workspace::reorder_repository,
            commands::workspace::set_repository_color,
            commands::workspace::add_section,
            commands::workspace::rename_section,
            commands::workspace::remove_section,
            commands::workspace::move_section,
            commands::workspace::set_section_collapsed,
            commands::workspace::set_repositories_section,
            commands::workspace::open_folder,
            commands::repo::history,
            commands::repo::rewrite_info,
            commands::repo::reword_commit,
            commands::repo::squash_commit,
            commands::repo::continue_operation,
            commands::repo::skip_commit,
            commands::repo::abort_operation,
            commands::repo::conflict_file,
            commands::repo::resolve_conflict,
            commands::repo::take_conflict_side,
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

mod agents;
mod error;
mod git;
mod persistence;
mod pty;
mod state;
mod tasks;

use state::AppState;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("ai_mush=info")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_agent,
            pty::write_to_agent,
            pty::resize_agent,
            pty::kill_agent,
            agents::list_agents,
            tasks::create_task,
            tasks::delete_task,
            git::get_changed_files,
            git::get_file_diff,
            git::get_gitignored_dirs,
            git::merge_task,
            persistence::save_app_state,
            persistence::load_app_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

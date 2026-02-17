mod agents;
mod error;
mod git;
mod persistence;
mod pty;
mod state;
mod tasks;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_agent,
            pty::write_to_agent,
            pty::resize_agent,
            pty::kill_agent,
            agents::list_agents,
            tasks::create_task,
            tasks::delete_task,
            tasks::list_tasks,
            tasks::set_project_root,
            git::get_changed_files,
            git::merge_task,
            persistence::save_app_state,
            persistence::load_app_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

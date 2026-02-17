use std::fs;
use std::path::PathBuf;
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

fn state_file_path(project_root: &str) -> PathBuf {
    PathBuf::from(project_root).join(".ai-mush").join("state.json")
}

#[tauri::command]
pub fn save_app_state(state: State<AppState>, json: String) -> Result<(), AppError> {
    let root = state.project_root.lock();
    let root = root.as_deref().ok_or_else(|| {
        AppError::Git("No project root set".into())
    })?;

    let path = state_file_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, json)?;
    Ok(())
}

#[tauri::command]
pub fn load_app_state(state: State<AppState>) -> Result<Option<String>, AppError> {
    let root = state.project_root.lock();
    let root = match root.as_deref() {
        Some(r) => r,
        None => return Ok(None),
    };

    let path = state_file_path(root);
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)?;
    Ok(Some(content))
}

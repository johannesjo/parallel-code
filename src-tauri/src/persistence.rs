use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use crate::error::AppError;

fn state_file_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Git(format!("Failed to resolve app data dir: {}", e)))?;

    if cfg!(debug_assertions) {
        if let Some(name) = dir.file_name() {
            dir.set_file_name(format!("{}-dev", name.to_string_lossy()));
        } else {
            dir.push("dev");
        }
    }

    Ok(dir.join("state.json"))
}

#[tauri::command]
pub fn save_app_state(app: tauri::AppHandle, json: String) -> Result<(), AppError> {
    let path = state_file_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Atomic write: write to temp file, then rename (atomic on POSIX)
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &json)?;

    // Keep one backup of the previous state
    if path.exists() {
        let backup_path = path.with_extension("json.bak");
        let _ = fs::rename(&path, &backup_path);
    }

    fs::rename(&tmp_path, &path)?;
    Ok(())
}

#[tauri::command]
pub fn load_app_state(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    let path = state_file_path(&app)?;

    // Try primary state file first
    if path.exists() {
        let content = fs::read_to_string(&path)?;
        if !content.trim().is_empty() {
            return Ok(Some(content));
        }
    }

    // Fall back to backup if primary is missing or empty
    let backup_path = path.with_extension("json.bak");
    if backup_path.exists() {
        let content = fs::read_to_string(&backup_path)?;
        if !content.trim().is_empty() {
            return Ok(Some(content));
        }
    }

    Ok(None)
}

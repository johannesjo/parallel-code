pub mod types;

use tracing::{info, error};
use uuid::Uuid;

use crate::error::AppError;
use crate::git;
use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct CreateTaskResult {
    pub id: String,
    pub branch_name: String,
    pub worktree_path: String,
}

#[tauri::command]
pub async fn create_task(
    name: String,
    project_root: String,
    symlink_dirs: Vec<String>,
) -> Result<CreateTaskResult, AppError> {
    let branch_name = format!("task/{}", slug(&name));
    info!(name = %name, branch = %branch_name, root = %project_root, "Creating task");

    let bn = branch_name.clone();
    let pr = project_root.clone();

    let worktree = tauri::async_runtime::spawn_blocking(move || {
        git::create_worktree(&pr, &bn, &symlink_dirs)
    })
    .await
    .map_err(|e| {
        error!(branch = %branch_name, err = %e, "Failed to create worktree (join)");
        AppError::Git(e.to_string())
    })?
    .map_err(|e| {
        error!(branch = %branch_name, err = %e, "Failed to create worktree");
        e
    })?;

    let id = Uuid::new_v4().to_string();
    info!(id = %id, branch = %worktree.branch, path = %worktree.path, "Task created");

    Ok(CreateTaskResult {
        id,
        branch_name: worktree.branch,
        worktree_path: worktree.path,
    })
}

#[tauri::command]
pub async fn delete_task(
    state: tauri::State<'_, AppState>,
    agent_ids: Vec<String>,
    branch_name: String,
    delete_branch: bool,
    project_root: String,
) -> Result<(), AppError> {
    info!(branch = %branch_name, agents = ?agent_ids, delete_branch, "Deleting task");

    // Kill all agent PTY sessions
    {
        let mut sessions = state.sessions.lock();
        for agent_id in &agent_ids {
            if let Some(session) = sessions.remove(agent_id) {
                let mut child = session.child.lock();
                let _ = child.kill();
                info!(agent_id = %agent_id, "Killed agent session");
            }
        }
    }

    let bn = branch_name.clone();
    tauri::async_runtime::spawn_blocking(move || {
        git::remove_worktree(&project_root, &bn, delete_branch)
    })
    .await
    .map_err(|e| {
        error!(branch = %branch_name, err = %e, "Failed to remove worktree (join)");
        AppError::Git(e.to_string())
    })?
    .map_err(|e| {
        error!(branch = %branch_name, err = %e, "Failed to remove worktree");
        e
    })?;

    info!(branch = %branch_name, "Task deleted");
    Ok(())
}

fn slug(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
        .replace("--", "-")
}

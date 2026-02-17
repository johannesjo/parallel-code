pub mod types;

use uuid::Uuid;

use crate::error::AppError;
use crate::git;
use crate::state::AppState;
use types::{Task, TaskStatus};

#[derive(serde::Serialize)]
pub struct CreateTaskResult {
    pub id: String,
    pub branch_name: String,
    pub worktree_path: String,
}

#[tauri::command]
pub fn create_task(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<CreateTaskResult, AppError> {
    let project_root = state.project_root.lock();
    let project_root = project_root
        .as_ref()
        .ok_or_else(|| AppError::Git("No project root set".into()))?;

    let branch_name = format!("task/{}", slug(&name));
    let worktree = git::create_worktree(project_root, &branch_name)?;

    let id = Uuid::new_v4().to_string();
    let task = Task {
        id: id.clone(),
        name: name.clone(),
        branch_name: worktree.branch.clone(),
        worktree_path: worktree.path.clone(),
        agent_ids: vec![],
        status: TaskStatus::Active,
    };

    state.tasks.lock().insert(id.clone(), task);

    Ok(CreateTaskResult {
        id,
        branch_name: worktree.branch,
        worktree_path: worktree.path,
    })
}

#[tauri::command]
pub fn delete_task(
    state: tauri::State<'_, AppState>,
    task_id: String,
    branch_name: String,
    delete_branch: bool,
) -> Result<(), AppError> {
    let project_root = state.project_root.lock();
    let project_root = project_root
        .as_ref()
        .ok_or_else(|| AppError::Git("No project root set".into()))?;

    // Kill all agents from Rust state if present
    let mut tasks = state.tasks.lock();
    if let Some(task) = tasks.get(&task_id) {
        let mut sessions = state.sessions.lock();
        for agent_id in &task.agent_ids {
            if let Some(session) = sessions.remove(agent_id) {
                let mut child = session.child.lock();
                let _ = child.kill();
            }
        }
    }
    tasks.remove(&task_id);
    drop(tasks);

    git::remove_worktree(project_root, &branch_name, delete_branch)?;

    Ok(())
}

#[tauri::command]
pub fn list_tasks(state: tauri::State<'_, AppState>) -> Vec<Task> {
    state.tasks.lock().values().cloned().collect()
}

#[tauri::command]
pub fn set_project_root(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), AppError> {
    *state.project_root.lock() = Some(path);
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

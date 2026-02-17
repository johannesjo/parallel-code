pub mod types;

use std::path::Path;
use std::process::Command;
use tracing::{info, error};

use crate::error::AppError;
use types::{ChangedFile, WorktreeInfo};

pub fn create_worktree(
    repo_root: &str,
    branch_name: &str,
    symlink_dirs: &[String],
) -> Result<WorktreeInfo, AppError> {
    let worktree_path = format!("{}/.worktrees/{}", repo_root, branch_name);
    info!(branch = %branch_name, path = %worktree_path, "Creating worktree");

    // Create the branch (ignore error if it already exists)
    let _ = Command::new("git")
        .args(["branch", branch_name])
        .current_dir(repo_root)
        .output();

    // Create the worktree
    let output = Command::new("git")
        .args(["worktree", "add", &worktree_path, branch_name])
        .current_dir(repo_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Git(format!(
            "Failed to create worktree: {}",
            stderr
        )));
    }

    // Symlink user-selected directories into the new worktree
    for name in symlink_dirs {
        let source = Path::new(repo_root).join(name);
        let target = Path::new(&worktree_path).join(name);
        if source.is_dir() && !target.exists() {
            let _ = std::os::unix::fs::symlink(&source, &target);
        }
    }

    Ok(WorktreeInfo {
        path: worktree_path,
        branch: branch_name.to_string(),
    })
}

/// Directories worth symlinking into worktrees: AI tool configs and dependencies.
const SYMLINK_CANDIDATES: &[&str] = &[
    ".claude",
    ".cursor",
    ".aider",
    ".copilot",
    ".codeium",
    ".continue",
    ".windsurf",
    "node_modules",
];

/// Return names of top-level gitignored directories that are useful to symlink.
#[tauri::command]
pub async fn get_gitignored_dirs(project_root: String) -> Result<Vec<String>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&project_root);
        Ok(SYMLINK_CANDIDATES
            .iter()
            .filter(|name| {
                let path = root.join(name);
                path.is_dir()
                    && Command::new("git")
                        .args(["check-ignore", "-q", name])
                        .current_dir(&project_root)
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false)
            })
            .map(|s| s.to_string())
            .collect())
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}

pub fn remove_worktree(
    repo_root: &str,
    branch_name: &str,
    delete_branch: bool,
) -> Result<(), AppError> {
    let worktree_path = format!("{}/.worktrees/{}", repo_root, branch_name);
    info!(branch = %branch_name, path = %worktree_path, delete_branch, "Removing worktree");

    let output = Command::new("git")
        .args(["worktree", "remove", "--force", &worktree_path])
        .current_dir(repo_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!(branch = %branch_name, stderr = %stderr, "Failed to remove worktree");
        return Err(AppError::Git(format!(
            "Failed to remove worktree: {}",
            stderr
        )));
    }

    if delete_branch {
        let _ = Command::new("git")
            .args(["branch", "-D", branch_name])
            .current_dir(repo_root)
            .output();
    }

    Ok(())
}

/// Detect the main branch name (main or master).
fn detect_main_branch(repo_root: &str) -> Result<String, AppError> {
    // Check if 'main' exists
    let output = Command::new("git")
        .args(["rev-parse", "--verify", "main"])
        .current_dir(repo_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;
    if output.status.success() {
        return Ok("main".into());
    }
    // Fallback to 'master'
    let output = Command::new("git")
        .args(["rev-parse", "--verify", "master"])
        .current_dir(repo_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;
    if output.status.success() {
        return Ok("master".into());
    }
    Err(AppError::Git("Could not find main or master branch".into()))
}

#[tauri::command]
pub async fn merge_task(
    project_root: String,
    branch_name: String,
) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        merge_task_sync(&project_root, &branch_name)
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}

fn merge_task_sync(project_root: &str, branch_name: &str) -> Result<String, AppError> {
    info!(branch = %branch_name, root = %project_root, "Merging task branch");
    let main_branch = detect_main_branch(project_root)?;

    // Checkout main branch in the repo root
    let output = Command::new("git")
        .args(["checkout", &main_branch])
        .current_dir(project_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Git(format!("Failed to checkout {}: {}", main_branch, stderr)));
    }

    // Merge feature branch
    let output = Command::new("git")
        .args(["merge", branch_name])
        .current_dir(project_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Git(format!("Merge failed: {}", stderr)));
    }

    // Remove worktree and delete feature branch
    remove_worktree(project_root, branch_name, true)?;

    Ok(main_branch)
}

#[tauri::command]
pub async fn get_changed_files(worktree_path: String) -> Result<Vec<ChangedFile>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        get_changed_files_sync(&worktree_path)
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}

fn get_changed_files_sync(worktree_path: &str) -> Result<Vec<ChangedFile>, AppError> {
    let mut files: Vec<ChangedFile> = Vec::new();
    let main_branch = detect_main_branch(worktree_path).unwrap_or_else(|_| "HEAD".into());

    // git diff --name-status against main: statuses for all tracked changes (committed + uncommitted)
    let name_status_str = Command::new("git")
        .args(["diff", "--name-status", &main_branch])
        .current_dir(worktree_path)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let mut status_map = std::collections::HashMap::new();
    for line in name_status_str.lines() {
        let parts: Vec<&str> = line.splitn(2, '\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let status = parts[0].chars().next().unwrap_or('M').to_string();
        let path = parts[1].to_string();
        status_map.insert(path, status);
    }

    // git status --porcelain for untracked files only
    let status_str = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree_path)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    for line in status_str.lines() {
        if line.starts_with("??") && line.len() >= 3 {
            let path = line[3..].trim_start().to_string();
            status_map.entry(path).or_insert_with(|| "?".to_string());
        }
    }

    // git diff --numstat against main for line counts
    let diff_str = Command::new("git")
        .args(["diff", "--numstat", &main_branch])
        .current_dir(worktree_path)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let mut seen = std::collections::HashSet::new();
    for line in diff_str.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let added = parts[0].parse::<u32>().unwrap_or(0);
        let removed = parts[1].parse::<u32>().unwrap_or(0);
        let path = parts[2].to_string();
        let status = status_map.get(&path).cloned().unwrap_or_else(|| "M".to_string());
        seen.insert(path.clone());
        files.push(ChangedFile {
            path,
            lines_added: added,
            lines_removed: removed,
            status,
        });
    }

    // Add files from status_map not covered by numstat (e.g. untracked files)
    for (path, status) in &status_map {
        if !seen.contains(path) {
            // Count lines for untracked/new files not in git diff
            let added = std::path::Path::new(worktree_path)
                .join(path)
                .metadata()
                .ok()
                .filter(|m| m.is_file())
                .and_then(|_| std::fs::read_to_string(std::path::Path::new(worktree_path).join(path)).ok())
                .map(|c| c.lines().count() as u32)
                .unwrap_or(0);
            files.push(ChangedFile {
                path: path.clone(),
                lines_added: added,
                lines_removed: 0,
                status: status.clone(),
            });
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

#[tauri::command]
pub async fn get_file_diff(worktree_path: String, file_path: String) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        get_file_diff_sync(&worktree_path, &file_path)
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}

fn get_file_diff_sync(worktree_path: &str, file_path: &str) -> Result<String, AppError> {
    let main_branch = detect_main_branch(worktree_path).unwrap_or_else(|_| "HEAD".into());

    // Try git diff against main branch
    let output = Command::new("git")
        .args(["diff", &main_branch, "--", file_path])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    let diff = String::from_utf8_lossy(&output.stdout).to_string();

    // If diff is empty, file might be untracked — read it and format as all-additions
    if diff.trim().is_empty() {
        let full_path = std::path::Path::new(worktree_path).join(file_path);
        if full_path.exists() {
            let content = std::fs::read_to_string(&full_path)
                .map_err(|e| AppError::Git(format!("Failed to read file: {}", e)))?;
            let lines: Vec<&str> = content.lines().collect();
            let count = lines.len();
            let mut pseudo = format!(
                "--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n",
                file_path, count
            );
            for line in &lines {
                pseudo.push('+');
                pseudo.push_str(line);
                pseudo.push('\n');
            }
            return Ok(pseudo);
        }
    }

    Ok(diff)
}

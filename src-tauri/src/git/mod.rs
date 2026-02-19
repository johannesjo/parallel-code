pub mod types;

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};
use parking_lot::Mutex;
use tracing::{info, error};

use crate::error::AppError;
use types::{ChangedFile, MergeResult, MergeStatus, WorktreeInfo, WorktreeStatus};

// --- TTL caches for expensive git queries ---

struct CacheEntry {
    value: String,
    expires_at: Instant,
}

static MAIN_BRANCH_CACHE: std::sync::LazyLock<Mutex<HashMap<String, CacheEntry>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

static MERGE_BASE_CACHE: std::sync::LazyLock<Mutex<HashMap<String, CacheEntry>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

const MAIN_BRANCH_TTL: Duration = Duration::from_secs(60);
const MERGE_BASE_TTL: Duration = Duration::from_secs(30);

/// Invalidate all merge base cache entries.
/// Called after rebase/merge operations that change the commit graph.
fn invalidate_merge_base_cache() {
    MERGE_BASE_CACHE.lock().clear();
}

pub fn create_worktree(
    repo_root: &str,
    branch_name: &str,
    symlink_dirs: &[String],
) -> Result<WorktreeInfo, AppError> {
    let worktree_path = format!("{}/.worktrees/{}", repo_root, branch_name);
    info!(branch = %branch_name, path = %worktree_path, "Creating worktree");

    // Create worktree with new branch atomically.
    // Try -b first (new branch); fall back to existing branch if it already exists.
    let output = Command::new("git")
        .args(["worktree", "add", "-b", branch_name, &worktree_path])
        .current_dir(repo_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    let output = if !output.status.success() {
        // Branch may already exist — try without -b
        Command::new("git")
            .args(["worktree", "add", &worktree_path, branch_name])
            .current_dir(repo_root)
            .output()
            .map_err(|e| AppError::Git(e.to_string()))?
    } else {
        output
    };

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
            #[cfg(unix)]
            let _ = std::os::unix::fs::symlink(&source, &target);
            #[cfg(windows)]
            let _ = std::os::windows::fs::symlink_dir(&source, &target);
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

#[tauri::command]
pub async fn get_main_branch(project_root: String) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        detect_main_branch(&project_root)
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

    // If the project directory no longer exists, there's nothing to clean up
    if !Path::new(repo_root).exists() {
        info!(root = %repo_root, "Project directory gone, skipping git cleanup");
        return Ok(());
    }

    if Path::new(&worktree_path).exists() {
        let output = Command::new("git")
            .args(["worktree", "remove", "--force", &worktree_path])
            .current_dir(repo_root)
            .output()
            .map_err(|e| AppError::Git(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // If git doesn't recognize it as a worktree, just remove the directory
            info!(branch = %branch_name, stderr = %stderr, "git worktree remove failed, removing directory directly");
            std::fs::remove_dir_all(&worktree_path).ok();
        }
    }

    // Prune stale worktree entries so git doesn't keep referencing missing directories
    let _ = Command::new("git")
        .args(["worktree", "prune"])
        .current_dir(repo_root)
        .output();

    if delete_branch {
        let _ = Command::new("git")
            .args(["branch", "-D", "--", branch_name])
            .current_dir(repo_root)
            .output();
    }

    Ok(())
}

/// Detect the main branch name (main or master). Cached with 60s TTL.
fn detect_main_branch(repo_root: &str) -> Result<String, AppError> {
    let key = repo_root.to_string();
    {
        let cache = MAIN_BRANCH_CACHE.lock();
        if let Some(entry) = cache.get(&key) {
            if entry.expires_at > Instant::now() {
                return Ok(entry.value.clone());
            }
        }
    }

    let result = detect_main_branch_uncached(repo_root)?;

    {
        let mut cache = MAIN_BRANCH_CACHE.lock();
        cache.insert(key, CacheEntry {
            value: result.clone(),
            expires_at: Instant::now() + MAIN_BRANCH_TTL,
        });
    }

    Ok(result)
}

fn detect_main_branch_uncached(repo_root: &str) -> Result<String, AppError> {
    // Try the remote HEAD reference first (handles custom default branch names)
    if let Ok(output) = Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD"])
        .current_dir(repo_root)
        .output()
    {
        if output.status.success() {
            let refname = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(branch) = refname.strip_prefix("refs/remotes/origin/") {
                return Ok(branch.to_string());
            }
        }
    }
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

fn get_current_branch_name(repo_root: &str) -> Result<String, AppError> {
    let output = Command::new("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(repo_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;
    if !output.status.success() {
        return Err(AppError::Git("HEAD is detached — not on any branch".into()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub async fn get_current_branch(project_root: String) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        get_current_branch_name(&project_root)
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}

/// Find the merge base between main and HEAD so diffs only show branch-specific changes.
/// Cached with 30s TTL per worktree path.
fn detect_merge_base(repo_root: &str) -> Result<String, AppError> {
    let key = repo_root.to_string();
    {
        let cache = MERGE_BASE_CACHE.lock();
        if let Some(entry) = cache.get(&key) {
            if entry.expires_at > Instant::now() {
                return Ok(entry.value.clone());
            }
        }
    }

    let main_branch = detect_main_branch(repo_root)?;
    let output = Command::new("git")
        .args(["merge-base", &main_branch, "HEAD"])
        .current_dir(repo_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    let result = if output.status.success() {
        let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !hash.is_empty() { hash } else { main_branch }
    } else {
        // Fallback to main branch name if merge-base fails (e.g. no common ancestor)
        main_branch
    };

    {
        let mut cache = MERGE_BASE_CACHE.lock();
        cache.insert(key, CacheEntry {
            value: result.clone(),
            expires_at: Instant::now() + MERGE_BASE_TTL,
        });
    }

    Ok(result)
}

#[tauri::command]
pub async fn merge_task(
    state: tauri::State<'_, crate::state::AppState>,
    project_root: String,
    branch_name: String,
    squash: bool,
    message: Option<String>,
    cleanup: bool,
) -> Result<MergeResult, AppError> {
    let lock = state.worktree_lock(&project_root);
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        merge_task_sync(&project_root, &branch_name, squash, message.as_deref(), cleanup)
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}

fn merge_task_sync(
    project_root: &str,
    branch_name: &str,
    squash: bool,
    message: Option<&str>,
    cleanup: bool,
) -> Result<MergeResult, AppError> {
    info!(branch = %branch_name, root = %project_root, squash, cleanup, "Merging task branch");
    let main_branch = detect_main_branch(project_root)?;
    let (lines_added, lines_removed) = compute_branch_diff_stats(project_root, &main_branch, branch_name)?;

    // Verify project root has a clean working tree before switching branches
    let status_output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(project_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;
    if !status_output.stdout.is_empty() {
        return Err(AppError::Git(
            "Project root has uncommitted changes. Please commit or stash them before merging.".into()
        ));
    }

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

    if squash {
        // Squash merge: stages all changes without committing
        let output = Command::new("git")
            .args(["merge", "--squash", "--", branch_name])
            .current_dir(project_root)
            .output()
            .map_err(|e| AppError::Git(e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::Git(format!("Squash merge failed: {}", stderr)));
        }

        // Commit with the provided message
        let msg = message.unwrap_or("Squash merge");
        let output = Command::new("git")
            .args(["commit", "-m", msg])
            .current_dir(project_root)
            .output()
            .map_err(|e| AppError::Git(e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::Git(format!("Commit failed: {}", stderr)));
        }
    } else {
        // Regular merge
        let output = Command::new("git")
            .args(["merge", "--", branch_name])
            .current_dir(project_root)
            .output()
            .map_err(|e| AppError::Git(e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::Git(format!("Merge failed: {}", stderr)));
        }
    }

    // Merge moved main forward — merge base for all worktrees changed.
    invalidate_merge_base_cache();

    if cleanup {
        // Remove worktree and delete feature branch.
        remove_worktree(project_root, branch_name, true)?;
    }

    Ok(MergeResult {
        main_branch,
        lines_added,
        lines_removed,
    })
}

fn compute_branch_diff_stats(
    project_root: &str,
    main_branch: &str,
    branch_name: &str,
) -> Result<(u32, u32), AppError> {
    let output = Command::new("git")
        .args(["diff", "--numstat", &format!("{}..{}", main_branch, branch_name)])
        .current_dir(project_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Git(format!("Failed to collect merge diff stats: {}", stderr)));
    }

    let diff_str = String::from_utf8_lossy(&output.stdout);
    let mut lines_added: u32 = 0;
    let mut lines_removed: u32 = 0;

    for line in diff_str.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        lines_added = lines_added.saturating_add(parts[0].parse::<u32>().unwrap_or(0));
        lines_removed = lines_removed.saturating_add(parts[1].parse::<u32>().unwrap_or(0));
    }

    Ok((lines_added, lines_removed))
}

/// Get commit log for a branch relative to main (for pre-filling squash messages).
#[tauri::command]
pub async fn get_branch_log(
    worktree_path: String,
) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        get_branch_log_sync(&worktree_path)
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}

fn get_branch_log_sync(worktree_path: &str) -> Result<String, AppError> {
    let main_branch = detect_main_branch(worktree_path).unwrap_or_else(|_| "HEAD".into());

    let output = Command::new("git")
        .args(["log", &format!("{}..HEAD", main_branch), "--pretty=format:- %s"])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub async fn push_task(
    project_root: String,
    branch_name: String,
) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        push_task_sync(&project_root, &branch_name)
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}

fn push_task_sync(project_root: &str, branch_name: &str) -> Result<(), AppError> {
    info!(branch = %branch_name, root = %project_root, "Pushing task branch to remote");

    let output = Command::new("git")
        .args(["push", "-u", "origin", "--", branch_name])
        .current_dir(project_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Git(format!("Push failed: {}", stderr)));
    }

    Ok(())
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
    let base = detect_merge_base(worktree_path).unwrap_or_else(|_| "HEAD".into());

    // Single git diff call: --name-status + --numstat in one subprocess
    let diff_str = Command::new("git")
        .args(["diff", "--name-status", "--numstat", &base])
        .current_dir(worktree_path)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_else(|e| {
            tracing::warn!("git diff --name-status --numstat failed: {}", e);
            String::new()
        });

    // Parse combined output: numstat lines have 3 tab-separated fields (added\tremoved\tpath),
    // name-status lines have 2 tab-separated fields (status\tpath).
    let mut status_map = std::collections::HashMap::new();
    let mut numstat_map: std::collections::HashMap<String, (u32, u32)> = std::collections::HashMap::new();
    for line in diff_str.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            // numstat line: added\tremoved\tpath
            if let (Ok(added), Ok(removed)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                let raw_path = parts.last().copied().unwrap_or_default();
                let path = normalize_status_path(raw_path);
                if !path.is_empty() {
                    numstat_map.insert(path, (added, removed));
                }
                continue;
            }
        }
        if parts.len() >= 2 {
            // name-status line: status\tpath
            let status = parts[0].chars().next().unwrap_or('M').to_string();
            let raw_path = parts.last().copied().unwrap_or_default();
            let path = normalize_status_path(raw_path);
            if !path.is_empty() {
                status_map.insert(path, status);
            }
        }
    }

    // git status --porcelain: collect all uncommitted paths + untracked files
    let status_str = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree_path)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_else(|e| {
            tracing::warn!("git status --porcelain failed: {}", e);
            String::new()
        });

    let mut uncommitted_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in status_str.lines() {
        if line.len() < 3 { continue; }
        let path = normalize_status_path(line[3..].trim_start());
        if path.is_empty() {
            continue;
        }
        if line.starts_with("??") {
            status_map.entry(path.clone()).or_insert_with(|| "?".to_string());
        }
        uncommitted_paths.insert(path);
    }

    let mut seen = std::collections::HashSet::new();
    for (path, (added, removed)) in &numstat_map {
        let status = status_map.get(path).cloned().unwrap_or_else(|| "M".to_string());
        let committed = !uncommitted_paths.contains(path);
        seen.insert(path.clone());
        files.push(ChangedFile {
            path: path.clone(),
            lines_added: *added,
            lines_removed: *removed,
            status,
            committed,
        });
    }

    // Add files from status_map not covered by numstat (e.g. untracked files)
    let worktree = Path::new(worktree_path);
    for (path, status) in &status_map {
        if !seen.contains(path) {
            // Count lines for untracked/new files without reading entire file into memory
            let full_path = worktree.join(path);
            let added = full_path
                .metadata()
                .ok()
                .filter(|m| m.is_file())
                .and_then(|_| {
                    use std::io::BufRead;
                    std::fs::File::open(&full_path)
                        .ok()
                        .map(|f| std::io::BufReader::new(f).lines().count() as u32)
                })
                .unwrap_or(0);
            files.push(ChangedFile {
                path: path.clone(),
                lines_added: added,
                lines_removed: 0,
                status: status.clone(),
                committed: !uncommitted_paths.contains(path),
            });
        }
    }

    files.sort_by(|a, b| a.committed.cmp(&b.committed).then_with(|| a.path.cmp(&b.path)));
    Ok(files)
}

fn normalize_status_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Handle rename/copy strings like "old/path -> new/path".
    let destination = trimmed.rsplit(" -> ").next().unwrap_or(trimmed).trim();
    destination
        .trim_start_matches('"')
        .trim_end_matches('"')
        .to_string()
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
    let base = detect_merge_base(worktree_path).unwrap_or_else(|_| "HEAD".into());

    // Try git diff against merge base (only branch-specific changes)
    let output = Command::new("git")
        .args(["diff", &base, "--", file_path])
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
            let count = content.lines().count();
            let mut pseudo = format!(
                "--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n",
                file_path, count
            );
            for line in content.lines() {
                pseudo.push('+');
                pseudo.push_str(line);
                pseudo.push('\n');
            }
            return Ok(pseudo);
        }
    }

    Ok(diff)
}

#[tauri::command]
pub async fn get_worktree_status(worktree_path: String) -> Result<WorktreeStatus, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        get_worktree_status_sync(&worktree_path)
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}

#[tauri::command]
pub async fn check_merge_status(
    state: tauri::State<'_, crate::state::AppState>,
    worktree_path: String,
) -> Result<MergeStatus, AppError> {
    let lock = state.worktree_lock(&worktree_path);
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        check_merge_status_sync(&worktree_path)
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}

fn check_merge_status_sync(worktree_path: &str) -> Result<MergeStatus, AppError> {
    let main_branch = detect_main_branch(worktree_path)?;

    // Count how many commits main is ahead of HEAD
    let output = Command::new("git")
        .args(["rev-list", "--count", &format!("HEAD..{}", main_branch)])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    let count_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let main_ahead_count: u32 = count_str.parse().unwrap_or(0);

    if main_ahead_count == 0 {
        return Ok(MergeStatus {
            main_ahead_count: 0,
            conflicting_files: vec![],
        });
    }

    // Use merge-tree for a true dry-run that doesn't touch the worktree or index
    let merge_output = Command::new("git")
        .args(["merge-tree", "--write-tree", "HEAD", &main_branch])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    let mut conflicting_files = vec![];

    if !merge_output.status.success() {
        // merge-tree --write-tree outputs: tree hash on first line, then CONFLICT lines.
        // Parse file paths from CONFLICT messages (works for all file types including extensionless).
        // Formats: "CONFLICT (content): Merge conflict in <path>"
        //          "CONFLICT (modify/delete): <path> deleted in ..."
        let output_str = String::from_utf8_lossy(&merge_output.stdout);
        for line in output_str.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with("CONFLICT") {
                continue;
            }
            // Try "Merge conflict in <path>" pattern first
            if let Some(i) = trimmed.find("Merge conflict in ") {
                let path = trimmed[i + "Merge conflict in ".len()..].trim();
                if !path.is_empty() {
                    conflicting_files.push(path.to_string());
                    continue;
                }
            }
            // Fallback: extract first token after "): " as the path
            if let Some(after_paren) = trimmed.find("): ").map(|i| &trimmed[i + 3..]) {
                if let Some(path) = after_paren.split_whitespace().next() {
                    if !path.is_empty() {
                        conflicting_files.push(path.to_string());
                    }
                }
            }
        }
        // If stdout parsing found nothing, try stderr as fallback
        if conflicting_files.is_empty() {
            let stderr = String::from_utf8_lossy(&merge_output.stderr);
            for line in stderr.lines() {
                if let Some(rest) = line.find("Merge conflict in ").map(|i| &line[i + "Merge conflict in ".len()..]) {
                    let path = rest.trim();
                    if !path.is_empty() {
                        conflicting_files.push(path.to_string());
                    }
                }
            }
        }
    }

    Ok(MergeStatus {
        main_ahead_count,
        conflicting_files,
    })
}

#[tauri::command]
pub async fn rebase_task(
    state: tauri::State<'_, crate::state::AppState>,
    worktree_path: String,
) -> Result<(), AppError> {
    let lock = state.worktree_lock(&worktree_path);
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        rebase_task_sync(&worktree_path)
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}

fn rebase_task_sync(worktree_path: &str) -> Result<(), AppError> {
    let main_branch = detect_main_branch(worktree_path)?;
    info!(main = %main_branch, path = %worktree_path, "Rebasing task onto main");

    let output = Command::new("git")
        .args(["rebase", &main_branch])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    if !output.status.success() {
        // Abort the failed rebase to restore clean state
        let _ = Command::new("git")
            .args(["rebase", "--abort"])
            .current_dir(worktree_path)
            .output();

        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Git(format!("Rebase failed: {}", stderr)));
    }

    // Rebase moved commits — merge base for this (and possibly other) worktrees changed.
    invalidate_merge_base_cache();

    Ok(())
}

fn get_worktree_status_sync(worktree_path: &str) -> Result<WorktreeStatus, AppError> {
    // Check for uncommitted changes via git status --porcelain
    let status_output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;
    let has_uncommitted_changes = !status_output.stdout.is_empty();

    // Check for committed changes vs main branch
    let main_branch = detect_main_branch(worktree_path).unwrap_or_else(|_| "HEAD".into());
    let log_output = Command::new("git")
        .args(["log", &format!("{}..HEAD", main_branch), "--oneline"])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;
    let has_committed_changes = !log_output.stdout.is_empty();

    Ok(WorktreeStatus {
        has_committed_changes,
        has_uncommitted_changes,
    })
}

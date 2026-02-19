use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tracing::{info, warn};

static LOGIN_PATH: OnceLock<Option<String>> = OnceLock::new();

const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);

/// Returns the user's login shell PATH, resolved once.
///
/// When the app is launched from a `.desktop` file or macOS Finder, the
/// process PATH is minimal (`/usr/bin:/bin:/usr/sbin:/sbin`) and doesn't
/// include directories like `~/.nvm/.../bin` or `/opt/homebrew/bin`.
///
/// Resolution strategy:
/// 1. Run login shell with `-lc` (non-interactive to avoid TTY-dependent
///    plugins like Powerlevel10k breaking the output).
/// 2. Explicitly source `~/.zshrc` / `~/.bashrc` (many tools only add
///    PATH entries there, not in login profiles).
/// 3. On macOS, fall back to `/usr/libexec/path_helper` which reads
///    `/etc/paths` and `/etc/paths.d/*`.
/// 4. As a last resort on macOS, return a set of common tool directories.
pub fn login_path() -> Option<&'static str> {
    LOGIN_PATH
        .get_or_init(|| {
            let mut paths: Vec<String> = Vec::new();

            // 1. Try login shell (non-interactive to avoid TTY issues).
            //    This sources .zprofile / .bash_profile but NOT .zshrc / .bashrc.
            if let Some(p) = resolve_via_login_shell() {
                paths.push(p);
            }

            // 2. Try sourcing the rc file directly (for PATH entries only in .zshrc/.bashrc)
            if let Some(p) = resolve_via_rc_file() {
                paths.push(p);
            }

            if !paths.is_empty() {
                let merged = merge_paths(&paths);
                info!(path = %merged, "Resolved PATH");
                return Some(merged);
            }

            // 3. macOS: try path_helper
            #[cfg(target_os = "macos")]
            if let Some(p) = resolve_via_path_helper() {
                return Some(p);
            }

            // 4. macOS: hardcoded fallback with common tool directories
            #[cfg(target_os = "macos")]
            {
                let fallback = macos_fallback_path();
                warn!(path = %fallback, "Using macOS fallback PATH");
                return Some(fallback);
            }

            #[allow(unreachable_code)]
            None
        })
        .as_deref()
}

/// Resolve a command name to an absolute path using the login PATH.
///
/// - Absolute or relative paths (contain `/`) are returned unchanged.
/// - Bare names are searched in the login PATH (or process PATH as fallback).
/// - If not found, the original name is returned so downstream errors surface.
pub fn resolve_command(command: &str) -> String {
    // Already absolute or relative — pass through.
    if command.contains('/') {
        return command.to_string();
    }

    // Determine which PATH to search: prefer login PATH, fall back to process PATH.
    let search_path = login_path()
        .map(|s| s.to_string())
        .or_else(|| std::env::var("PATH").ok());

    if let Some(path_str) = search_path {
        for dir in path_str.split(':') {
            let candidate = PathBuf::from(dir).join(command);
            if is_executable(&candidate) {
                let resolved = candidate.to_string_lossy().to_string();
                info!(command = %command, resolved = %resolved, "Resolved command to absolute path");
                return resolved;
            }
        }
    }

    warn!(command = %command, "Could not resolve command to absolute path; using as-is");
    command.to_string()
}

/// Check if a path exists and has the executable bit set.
#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file()
        && path
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Resolve PATH by running the user's login shell with `-lc`.
///
/// Uses `-lc` (login, command) instead of `-lic` (login, interactive, command)
/// because interactive mode requires a TTY and can hang or fail with shell
/// plugins like Powerlevel10k, oh-my-zsh instant prompt, etc.
fn resolve_via_login_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let stdout = run_with_timeout(
        &shell,
        &["-lc", r#"printf "MUSH_PATH:%s\n" "$PATH""#],
    )?;

    let path = stdout
        .lines()
        .find_map(|line| line.strip_prefix("MUSH_PATH:"));

    match path {
        Some(p) if !p.is_empty() && !is_minimal_path(p) => {
            info!(path = %p, shell = %shell, "Resolved login shell PATH");
            Some(p.to_string())
        }
        _ => {
            warn!(shell = %shell, "Login shell returned no usable PATH");
            None
        }
    }
}

/// Try sourcing `~/.zshrc` or `~/.bashrc` explicitly to pick up PATH entries
/// that only live in rc files (nvm, pyenv, Homebrew shellenv, etc.).
///
/// Uses `-c` with explicit `source` rather than `-i` to avoid TTY requirements.
fn resolve_via_rc_file() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| String::new());
    let shell_name = shell.rsplit('/').next().unwrap_or("");

    let source_cmd = match shell_name {
        "zsh" => r#"[ -f ~/.zshrc ] && source ~/.zshrc 2>/dev/null; printf "MUSH_PATH:%s\n" "$PATH""#,
        "bash" => r#"[ -f ~/.bashrc ] && source ~/.bashrc 2>/dev/null; printf "MUSH_PATH:%s\n" "$PATH""#,
        _ => return None,
    };

    let stdout = run_with_timeout(&shell, &["-c", source_cmd])?;

    let path = stdout
        .lines()
        .find_map(|line| line.strip_prefix("MUSH_PATH:"));

    match path {
        Some(p) if !p.is_empty() && !is_minimal_path(p) => {
            info!(path = %p, shell = %shell, "Resolved rc file PATH");
            Some(p.to_string())
        }
        _ => None,
    }
}

/// On macOS, `/usr/libexec/path_helper` reads `/etc/paths` and `/etc/paths.d/*`
/// to construct the system PATH. This is the same mechanism `/etc/zprofile` uses.
#[cfg(target_os = "macos")]
fn resolve_via_path_helper() -> Option<String> {
    let stdout = run_with_timeout("/usr/libexec/path_helper", &["-s"])?;

    // path_helper outputs lines like: PATH="..."; export PATH;
    let path = stdout.lines().find_map(|line| {
        line.strip_prefix("PATH=\"")
            .and_then(|s| s.split('"').next())
    });

    match path {
        Some(p) if !p.is_empty() && !is_minimal_path(p) => {
            info!(path = %p, "Resolved macOS path_helper PATH");
            Some(p.to_string())
        }
        _ => {
            warn!("path_helper returned no usable PATH");
            None
        }
    }
}

/// Construct a fallback PATH from common macOS tool directories.
#[cfg(target_os = "macos")]
fn macos_fallback_path() -> String {
    let home = std::env::var("HOME").ok();
    let mut candidates: Vec<String> = Vec::new();

    if let Some(ref h) = home {
        // Node version managers — pick the latest installed version
        if let Some(dir) = find_latest_version_dir(&format!("{h}/.nvm/versions/node"), "bin") {
            candidates.push(dir);
        }
        if let Some(dir) = find_latest_version_dir(
            &format!("{h}/.local/share/fnm/node-versions"),
            "installation/bin",
        ) {
            candidates.push(dir);
        }

        candidates.extend([
            format!("{h}/n/bin"),
            format!("{h}/.asdf/shims"),
            format!("{h}/.local/bin"),
            format!("{h}/.cargo/bin"),
            format!("{h}/.volta/bin"),
        ]);
    }

    candidates.extend([
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/local/sbin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ]);

    candidates
        .into_iter()
        .filter(|p| Path::new(p).is_dir())
        .collect::<Vec<_>>()
        .join(":")
}

/// Scan a directory of versioned subdirectories (e.g. `v18.19.0`, `v20.11.1`)
/// and return `<latest_version>/<suffix>` if any exist.
#[cfg(target_os = "macos")]
fn find_latest_version_dir(base: &str, suffix: &str) -> Option<String> {
    let entries = std::fs::read_dir(base).ok()?;
    let latest = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.metadata().map(|m| m.is_dir()).unwrap_or(false))
        .max_by(|a, b| {
            human_sort_key(a.file_name().to_string_lossy().as_ref())
                .cmp(&human_sort_key(b.file_name().to_string_lossy().as_ref()))
        })?;
    let full = PathBuf::from(latest.path()).join(suffix);
    if full.is_dir() {
        Some(full.to_string_lossy().to_string())
    } else {
        None
    }
}

/// Build a sort key from a version-like string: strip leading `v`, split on `.`/`-`,
/// and parse each segment as a number (falling back to 0).
#[cfg(target_os = "macos")]
fn human_sort_key(s: &str) -> Vec<u64> {
    let stripped = s.strip_prefix('v').unwrap_or(s);
    stripped
        .split(|c: char| c == '.' || c == '-')
        .map(|seg| seg.parse::<u64>().unwrap_or(0))
        .collect()
}

/// Run a command with a timeout, returning its stdout on success.
fn run_with_timeout(program: &str, args: &[&str]) -> Option<String> {
    let mut child = std::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| warn!(program = %program, err = %e, "Failed to spawn"))
        .ok()?;

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > RESOLVE_TIMEOUT {
                    warn!(program = %program, "Timed out resolving PATH");
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                warn!(program = %program, err = %e, "Error waiting for process");
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    let output = child.wait_with_output().ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Returns true if the PATH looks like the minimal macOS/Linux default
/// (i.e., only system directories, no user tool directories).
fn is_minimal_path(path: &str) -> bool {
    let entries: Vec<&str> = path.split(':').collect();
    // Note: /usr/local/bin is NOT minimal — Homebrew on Intel Macs installs there.
    entries.iter().all(|e| {
        matches!(*e, "/usr/bin" | "/bin" | "/usr/sbin" | "/sbin")
    }) && entries.len() <= 4
}

/// Merge multiple PATH strings, deduplicating entries while preserving order.
fn merge_paths(paths: &[String]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    for path_str in paths {
        for entry in path_str.split(':') {
            if !entry.is_empty() && seen.insert(entry.to_string()) {
                result.push(entry.to_string());
            }
        }
    }

    result.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_command_absolute_path_passthrough() {
        let result = resolve_command("/usr/bin/ls");
        assert_eq!(result, "/usr/bin/ls");
    }

    #[test]
    fn resolve_command_relative_path_passthrough() {
        let result = resolve_command("./my-script");
        assert_eq!(result, "./my-script");
    }

    #[test]
    fn resolve_command_known_binary_resolves() {
        let result = resolve_command("ls");
        assert!(
            result.ends_with("/ls"),
            "Expected absolute path ending in /ls, got: {result}"
        );
        assert!(
            result.starts_with('/'),
            "Expected absolute path, got: {result}"
        );
    }

    #[test]
    fn resolve_command_nonexistent_returns_original() {
        let result = resolve_command("surely_no_binary_has_this_name_42");
        assert_eq!(result, "surely_no_binary_has_this_name_42");
    }

    #[test]
    fn is_minimal_path_positive() {
        assert!(is_minimal_path("/usr/bin:/bin:/usr/sbin:/sbin"));
        assert!(is_minimal_path("/usr/bin:/bin"));
    }

    #[test]
    fn is_minimal_path_negative() {
        assert!(!is_minimal_path(
            "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        ));
        assert!(!is_minimal_path("/home/user/.local/bin:/usr/bin:/bin"));
    }
}

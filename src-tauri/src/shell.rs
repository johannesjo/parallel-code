use std::process::Stdio;
use std::sync::OnceLock;
use tracing::{info, warn};

static LOGIN_PATH: OnceLock<Option<String>> = OnceLock::new();

/// Returns the user's login shell PATH, resolved once.
///
/// When the app is launched from a `.desktop` file or macOS Finder, the
/// process PATH is minimal (`/usr/bin:/bin:/usr/sbin:/sbin`) and doesn't
/// include directories like `~/.nvm/.../bin` or `/opt/homebrew/bin`.
///
/// Resolution strategy:
/// 1. Run login shell with `-lc` (non-interactive to avoid TTY-dependent
///    plugins like Powerlevel10k breaking the output).
/// 2. On macOS, fall back to `/usr/libexec/path_helper` which reads
///    `/etc/paths` and `/etc/paths.d/*`.
/// 3. As a last resort on macOS, return a set of common tool directories.
pub fn login_path() -> Option<&'static str> {
    LOGIN_PATH
        .get_or_init(|| {
            // 1. Try login shell (non-interactive to avoid TTY issues)
            if let Some(p) = resolve_via_login_shell() {
                return Some(p);
            }

            // 2. macOS: try path_helper
            #[cfg(target_os = "macos")]
            if let Some(p) = resolve_via_path_helper() {
                return Some(p);
            }

            // 3. macOS: hardcoded fallback with common tool directories
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

/// Resolve PATH by running the user's login shell with `-lc`.
///
/// Uses `-lc` (login, command) instead of `-lic` (login, interactive, command)
/// because interactive mode requires a TTY and can hang or fail with shell
/// plugins like Powerlevel10k, oh-my-zsh instant prompt, etc.
fn resolve_via_login_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-lc", r#"printf "MUSH_PATH:%s\n" "$PATH""#])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
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
        Err(e) => {
            warn!(shell = %shell, err = %e, "Failed to run login shell");
            None
        }
    }
}

/// On macOS, `/usr/libexec/path_helper` reads `/etc/paths` and `/etc/paths.d/*`
/// to construct the system PATH. This is the same mechanism `/etc/zprofile` uses.
#[cfg(target_os = "macos")]
fn resolve_via_path_helper() -> Option<String> {
    let output = std::process::Command::new("/usr/libexec/path_helper")
        .arg("-s")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            // path_helper outputs: PATH="..."; export PATH;
            let path = stdout
                .strip_prefix("PATH=\"")
                .and_then(|s| s.split('"').next());

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
        Err(e) => {
            warn!(err = %e, "Failed to run path_helper");
            None
        }
    }
}

/// Construct a fallback PATH from common macOS tool directories.
#[cfg(target_os = "macos")]
fn macos_fallback_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| String::from("/tmp"));
    let candidates = [
        format!("{home}/.local/bin"),
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/local/sbin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];

    candidates
        .into_iter()
        .filter(|p| std::path::Path::new(p).is_dir())
        .collect::<Vec<_>>()
        .join(":")
}

/// Returns true if the PATH looks like the minimal macOS/Linux default
/// (i.e., only system directories, no user tool directories).
fn is_minimal_path(path: &str) -> bool {
    let entries: Vec<&str> = path.split(':').collect();
    let dominated_by_system = entries.iter().all(|e| {
        matches!(
            *e,
            "/usr/bin" | "/bin" | "/usr/sbin" | "/sbin" | "/usr/local/bin"
        )
    });
    dominated_by_system && entries.len() <= 5
}

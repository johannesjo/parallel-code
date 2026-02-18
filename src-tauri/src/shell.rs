use std::process::Stdio;
use std::sync::OnceLock;
use tracing::{info, warn};

static LOGIN_PATH: OnceLock<Option<String>> = OnceLock::new();

/// Returns the user's login shell PATH, resolved once via `$SHELL -lic`.
///
/// When the app is launched from a `.desktop` file, the process PATH is
/// minimal and doesn't include directories like `~/.nvm/.../bin`. Running
/// the login shell sources the user's profile and gives us the full PATH.
pub fn login_path() -> Option<&'static str> {
    LOGIN_PATH
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let output = std::process::Command::new(&shell)
                .args(["-lic", r#"printf "MUSH_PATH:%s\n" "$PATH""#])
                .stdin(Stdio::null())
                .output();

            match output {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let path = stdout
                        .lines()
                        .find_map(|line| line.strip_prefix("MUSH_PATH:"));

                    match path {
                        Some(p) if !p.is_empty() => {
                            info!(path = %p, "Resolved login shell PATH");
                            Some(p.to_string())
                        }
                        _ => {
                            warn!(shell = %shell, "Login shell returned no PATH");
                            None
                        }
                    }
                }
                Err(e) => {
                    warn!(shell = %shell, err = %e, "Failed to run login shell");
                    None
                }
            }
        })
        .as_deref()
}

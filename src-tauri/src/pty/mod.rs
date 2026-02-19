pub mod types;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::Arc;
use parking_lot::Mutex;
use tauri::ipc::Channel;
use tracing::{info, error};

use base64::Engine as _;
use crate::error::AppError;
use crate::state::AppState;
use types::{PtyOutput, PtySession};

#[tauri::command]
#[allow(clippy::too_many_arguments)] // IPC command boundary; arguments map directly from frontend invoke payload.
pub fn spawn_agent(
    state: tauri::State<'_, AppState>,
    task_id: String,
    agent_id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
    on_output: Channel<PtyOutput>,
) -> Result<(), AppError> {
    info!(agent_id = %agent_id, task_id = %task_id, command = %command, cwd = %cwd, "Spawning agent");
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Pty(e.to_string()))?;

    let command = if command.is_empty() {
        if cfg!(windows) {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd".to_string())
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
        }
    } else {
        command
    };

    // Resolve bare command names to absolute paths so portable_pty doesn't
    // rely on the (possibly minimal) process PATH for lookup.
    let resolved_command = crate::shell::resolve_command(&command);

    let mut cmd = CommandBuilder::new(&resolved_command);
    cmd.args(&args);
    cmd.cwd(&cwd);

    // Set TERM so CLI tools render properly
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // Inject login shell PATH so commands resolve in .desktop launches
    if let Some(path) = crate::shell::login_path() {
        cmd.env("PATH", path);
    }

    // Clear env vars that prevent nested agent sessions
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE_SESSION");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");

    for (k, v) in &env {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| {
            AppError::Pty(format!(
                "Failed to spawn '{}' (resolved: '{}'): {}. \
                 Hint: the command may not be installed or not on PATH.",
                command, resolved_command, e
            ))
        })?;

    // Drop slave — we only need the master side
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Pty(e.to_string()))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::Pty(e.to_string()))?;

    let session = PtySession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        task_id: task_id.clone(),
        agent_id: agent_id.clone(),
        child: Arc::new(Mutex::new(child)),
    };

    let child_handle = session.child.clone();
    state.sessions.lock().insert(agent_id.clone(), session);

    // Spawn a blocking reader thread that streams output via Channel
    std::thread::Builder::new()
        .name(format!("pty-reader-{}", agent_id))
        .spawn(move || {
            let mut buf = [0u8; 16384];
            let mut batch = Vec::with_capacity(65536);
            let mut last_flush = std::time::Instant::now();
            let mut line_ring: VecDeque<String> = VecDeque::new();
            let mut current_line = String::new();
            const MAX_LINES: usize = 50;
            const BATCH_MAX: usize = 64 * 1024;
            const BATCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(8);

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Accumulate lines for crash diagnostics
                        let chunk = String::from_utf8_lossy(&buf[..n]);
                        for ch in chunk.chars() {
                            if ch == '\n' {
                                line_ring.push_back(std::mem::take(&mut current_line));
                                if line_ring.len() > MAX_LINES {
                                    let _ = line_ring.pop_front();
                                }
                            } else if ch != '\r' {
                                current_line.push(ch);
                            }
                        }

                        batch.extend_from_slice(&buf[..n]);

                        // Flush when batch is large enough or enough time has passed.
                        // Note: elapsed() is checked on the next read() return, not a
                        // real-time deadline — it's a minimum batching window.
                        if batch.len() >= BATCH_MAX || last_flush.elapsed() >= BATCH_INTERVAL {
                            let encoded = base64::engine::general_purpose::STANDARD.encode(&batch);
                            let _ = on_output.send(PtyOutput::Data(encoded));
                            batch.clear();
                            last_flush = std::time::Instant::now();
                        }
                    }
                    Err(_) => break,
                }
            }

            // Flush remaining buffered data
            if !batch.is_empty() {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&batch);
                let _ = on_output.send(PtyOutput::Data(encoded));
            }

            // Flush any trailing partial line
            if !current_line.is_empty() {
                line_ring.push_back(current_line);
                if line_ring.len() > MAX_LINES {
                    let _ = line_ring.pop_front();
                }
            }

            // Wait for child to get exit code and signal
            let status = child_handle.lock().wait().ok();
            let exit_code = status.as_ref().map(|s| s.exit_code());
            let signal = status.as_ref().and_then(|s| s.signal().map(String::from));

            let _ = on_output.send(PtyOutput::Exit {
                exit_code,
                signal,
                last_output: line_ring.into_iter().collect(),
            });
        })
        .map_err(|e| AppError::Pty(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub fn write_to_agent(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    data: String,
) -> Result<(), AppError> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&agent_id)
        .ok_or_else(|| AppError::AgentNotFound(agent_id.clone()))?;

    let mut writer = session.writer.lock();
    writer
        .write_all(data.as_bytes())
        .map_err(|e| AppError::Pty(e.to_string()))?;
    writer
        .flush()
        .map_err(|e| AppError::Pty(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub fn resize_agent(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&agent_id)
        .ok_or_else(|| AppError::AgentNotFound(agent_id.clone()))?;

    let master = session.master.lock();
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Pty(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub fn kill_agent(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<(), AppError> {
    let mut sessions = state.sessions.lock();
    if let Some(session) = sessions.remove(&agent_id) {
        info!(agent_id = %session.agent_id, task_id = %session.task_id, "Killing agent");
        let mut child = session.child.lock();
        if let Err(e) = child.kill() {
            error!(agent_id = %session.agent_id, task_id = %session.task_id, err = %e, "Failed to kill agent process");
        }
    }
    Ok(())
}

#[tauri::command]
pub fn count_running_agents(state: tauri::State<'_, AppState>) -> usize {
    let mut sessions = state.sessions.lock();

    // Remove stale sessions whose processes already exited so the count reflects live agents only.
    sessions.retain(|_, session| {
        let mut child = session.child.lock();
        match child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(e) => {
                error!(agent_id = %session.agent_id, task_id = %session.task_id, err = %e, "Failed to poll agent process; removing session");
                false
            }
        }
    });

    sessions.len()
}

#[tauri::command]
pub fn kill_all_agents(state: tauri::State<'_, AppState>) {
    let mut sessions = state.sessions.lock();
    let all_sessions: Vec<_> = sessions.drain().collect();
    drop(sessions);

    for (_, session) in all_sessions {
        info!(agent_id = %session.agent_id, task_id = %session.task_id, "Killing agent");
        let mut child = session.child.lock();
        if let Err(e) = child.kill() {
            error!(agent_id = %session.agent_id, task_id = %session.task_id, err = %e, "Failed to kill agent process");
        }
    }
}

pub mod types;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use parking_lot::Mutex;
use tauri::ipc::Channel;
use tracing::{info, error};

use crate::error::AppError;
use crate::state::AppState;
use types::{PtyOutput, PtySession};

#[tauri::command]
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

    let mut cmd = CommandBuilder::new(&command);
    cmd.args(&args);
    cmd.cwd(&cwd);

    // Set TERM so CLI tools render properly
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

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
        .map_err(|e| AppError::Pty(e.to_string()))?;

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
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = on_output.send(PtyOutput::Data(buf[..n].to_vec()));
                    }
                    Err(_) => break,
                }
            }
            // Wait for child to get exit code
            let exit_code = child_handle
                .lock()
                .wait()
                .ok()
                .map(|status| status.exit_code());
            let _ = on_output.send(PtyOutput::Exit(exit_code));
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
        info!(agent_id = %agent_id, "Killing agent");
        let mut child = session.child.lock();
        if let Err(e) = child.kill() {
            error!(agent_id = %agent_id, err = %e, "Failed to kill agent process");
        }
    }
    Ok(())
}

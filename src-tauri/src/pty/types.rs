use portable_pty::MasterPty;
use serde::Serialize;
use std::sync::Arc;
use parking_lot::Mutex;

pub struct PtySession {
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    pub task_id: String,
    pub agent_id: String,
    pub child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum PtyOutput {
    Data(String),  // base64-encoded bytes
    Exit {
        exit_code: Option<u32>,
        signal: Option<String>,
        last_output: Vec<String>,
    },
}

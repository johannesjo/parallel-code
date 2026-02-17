use parking_lot::Mutex;
use std::collections::HashMap;

use crate::agents::types::AgentDef;
use crate::pty::types::PtySession;

pub struct AppState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    pub agents: Vec<AgentDef>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            agents: AgentDef::defaults(),
        }
    }
}

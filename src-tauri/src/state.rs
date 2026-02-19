use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use crate::agents::types::AgentDef;
use crate::pty::types::PtySession;

pub struct AppState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    pub agents: Vec<AgentDef>,
    /// Per-worktree locks to serialize mutating git operations.
    pub worktree_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            agents: AgentDef::defaults(),
            worktree_locks: Mutex::new(HashMap::new()),
        }
    }

    /// Get or create a lock for a given worktree/repo path.
    pub fn worktree_lock(&self, path: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.worktree_locks.lock();
        locks
            .entry(path.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
}

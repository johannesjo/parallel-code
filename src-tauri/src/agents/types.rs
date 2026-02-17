use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct AgentDef {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub resume_args: Vec<String>,
    pub description: String,
}

impl AgentDef {
    pub fn defaults() -> Vec<Self> {
        vec![
            AgentDef {
                id: "claude-code".into(),
                name: "Claude Code".into(),
                command: "claude".into(),
                args: vec![],
                resume_args: vec!["--continue".into()],
                description: "Anthropic's Claude Code CLI agent".into(),
            },
            AgentDef {
                id: "codex".into(),
                name: "Codex CLI".into(),
                command: "codex".into(),
                args: vec![],
                resume_args: vec!["resume".into(), "--last".into()],
                description: "OpenAI's Codex CLI agent".into(),
            },
            AgentDef {
                id: "gemini".into(),
                name: "Gemini CLI".into(),
                command: "gemini".into(),
                args: vec![],
                resume_args: vec!["--resume".into(), "latest".into()],
                description: "Google's Gemini CLI agent".into(),
            },
        ]
    }
}

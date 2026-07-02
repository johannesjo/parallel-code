export interface AgentFrameFixture {
  name: string;
  frame: string;
}

export interface NotReadyAgentFrameFixture extends AgentFrameFixture {
  reason: 'startup_or_dialog' | 'busy' | 'no_prompt';
}

export const READY_AGENT_FRAME_FIXTURES: AgentFrameFixture[] = [
  {
    name: 'Claude prompt above long status footer',
    frame: [
      '│ >',
      '❯',
      '',
      'opus · /Users/brooksc/git/parallel-code/.worktrees/task-023-10-loading-states · ctx:24k/200k',
    ].join('\n'),
  },
  {
    name: 'Claude empty prompt with rotating suggestion',
    frame: [
      '─'.repeat(80),
      '❯ Try "how does <filepath> work?"',
      '─'.repeat(80),
      '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\r'),
  },
  {
    name: 'Claude empty insert mode at fresh prompt',
    frame: [
      '│ >',
      '-- INSERT --',
      'opus · /Users/brooksc/git/parallel-code/.worktrees/task-029-linting · ctx:0/200k',
    ].join('\n'),
  },
  {
    name: 'Claude insert mode with inline status footer',
    frame: [
      '▐▛███▜▌ Claude Code v2.1.153',
      '────────────────────────────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────────────────────────────',
      '--INSERT--⏵⏵ bypass permissions on (shift+tab to cycle)',
      'Sonnet 4 | ~/git/parallel-code/.worktrees/task/example',
    ].join('\r'),
  },
  {
    name: 'Codex prompt above long status footer',
    frame: [
      '›',
      '',
      'gpt-5.5 default · /Users/brooksc/git/parallel-code/.worktrees/task-028-unit-tests',
    ].join('\n'),
  },
  {
    name: 'Codex prompt with redraw-damaged escape sequences',
    frame:
      '13;15H s qg se q MCP server q q›Summarize recent commitsgpt-5.5 medium · ~/repo/.worktrees/task/example q',
  },
  {
    name: 'Gemini typed-message prompt',
    frame: [
      'workspace /Users/brooksc/git/parallel-code/.worktrees/task-gemini branch sandbox',
      '> Type your message or @path/to/file',
    ].join('\n'),
  },
];

export const NOT_READY_AGENT_FRAME_FIXTURES: NotReadyAgentFrameFixture[] = [
  {
    name: 'Codex still working with visible input line',
    reason: 'busy',
    frame: [
      '› Implement the requested fix',
      'gpt-5.5 default · /Users/brooksc/git/parallel-code/.worktrees/task-028-unit-tests',
      'Working (18m 51s • esc to interrupt) • 1 background terminal running • /stop to close',
    ].join('\n'),
  },
  {
    name: 'Codex MCP startup screen',
    reason: 'startup_or_dialog',
    frame: [
      'Starting MCP servers (0/2): codex_apps, parallel-code',
      'Booting MCP server parallel-code',
      '›',
    ].join('\n'),
  },
  {
    name: 'Agent trust dialog',
    reason: 'startup_or_dialog',
    frame: [
      'Do you trust the contents of this directory?',
      '› 1. Yes, continue',
      '2. No, quit',
      'Press enter to continue',
    ].join('\n'),
  },
  {
    name: 'TUI selection menu',
    reason: 'no_prompt',
    frame: ['❯ Option A', '  Option B', '  Option C', 'Choose an option to continue'].join('\n'),
  },
];

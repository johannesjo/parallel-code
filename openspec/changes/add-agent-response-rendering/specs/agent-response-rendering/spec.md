# Agent Response Rendering Specification

## ADDED Requirements

### Requirement: Panel is opt-in per task and only shown when supported

The app SHALL render the AI Response panel for a task only when the
user has explicitly enabled it for that task AND the task's agent has a
configured `responseSource`.

#### Scenario: Agent has no response source

- **WHEN** a task's selected agent has no
  `AgentDef.responseSource`
- **THEN** the response-panel toggle button is not rendered in the
  agent terminal toolbar
- **AND** no `StartAgentResponseWatcher` is sent for that task

#### Scenario: User enables the panel

- **WHEN** the user clicks the response-panel toggle on a task whose
  agent has a `responseSource`
- **THEN** the renderer stores `agentResponsePanelEnabled[taskId] =
  true` in `PersistedState`
- **AND** the renderer sends `StartAgentResponseWatcher` with the task
  id, agent id, resolved source, session id, and cwd
- **AND** the panel becomes visible in a vertical split alongside the
  terminal

#### Scenario: User disables the panel

- **WHEN** the user clicks the toggle while the panel is open
- **THEN** the renderer sends `StopAgentResponseWatcher` with the
  task id
- **AND** sets `agentResponsePanelEnabled[taskId] = false`
- **AND** hides the panel
- **AND** the existing terminal view is unaffected at any point

#### Scenario: Panel state is restored across restarts

- **WHEN** the app restarts and a task's
  `agentResponsePanelEnabled[taskId]` is `true`
- **THEN** the renderer reopens the panel for that task on mount
- **AND** issues a fresh `StartAgentResponseWatcher` using the agent's
  current session id

### Requirement: Session id is fixed at agent spawn

The app SHALL bind each agent invocation to a session id known to both
the agent process and the watcher, so the watcher never has to guess
which file to tail.

#### Scenario: Agent supports a session-id CLI flag

- **WHEN** an agent's `responseSource.sessionIdArg` is set
- **THEN** the backend generates a UUID v4 at spawn time
- **AND** injects `{flag} {uuid}` into the spawn args before invoking
  `node-pty`
- **AND** stores the uuid on the in-memory `PtySession` keyed by
  `(taskId, agentId)`
- **AND** subsequent `StartAgentResponseWatcher` requests for that
  agent receive the stored uuid

#### Scenario: Agent restarts

- **WHEN** the user restarts an agent within a task
- **THEN** a new UUID is generated for the new invocation
- **AND** the watcher (if active) is restarted against the new session
  file
- **AND** the panel's event log for that agent is cleared

### Requirement: Watcher tails the session file forward-only

The backend SHALL read the agent's structured session log
forward-only, starting from byte 0 the first time the watcher opens
the file, and continuing from the last-read offset across subsequent
filesystem events.

#### Scenario: File grows

- **WHEN** the agent process appends one or more complete JSONL lines
  to the watched file
- **THEN** the watcher reads from `lastOffset` to the new end of file
- **AND** splits the read on `\n`
- **AND** updates `lastOffset` to the byte position immediately after
  the last `\n` read
- **AND** holds any trailing partial line in a buffer until the next
  newline arrives

#### Scenario: File does not yet exist

- **WHEN** `StartAgentResponseWatcher` is received but the resolved
  path does not yet exist
- **THEN** the backend polls `fs.stat` every 250 ms until the file
  exists or the watcher is stopped
- **AND** no event is pushed during the polling window

#### Scenario: Malformed JSON line

- **WHEN** the watcher reads a complete line that does not parse as
  JSON or does not match a known event shape
- **THEN** the line is logged at warn level with the byte offset
- **AND** is not converted into an `AgentResponseEvent`
- **AND** the watcher continues with the next line

#### Scenario: `fs.watch` unavailable

- **WHEN** the platform's `fs.watch` does not fire change events for
  the watched file (some Linux network filesystems)
- **THEN** the backend falls back to a `fs.stat` poll at 500 ms
  intervals
- **AND** otherwise behaves identically

### Requirement: Adapter normalises agent-specific events

Each adapter SHALL convert raw native events into the shared
`AgentResponseEvent` shape so renderer code is agent-agnostic.

#### Scenario: Claude Code assistant message with mixed blocks

- **WHEN** the `claude-code-v1` adapter reads an assistant `SDKMessage`
  whose `content` is
  `[{type:'text',text:'A'}, {type:'tool_use',id:'t1',name:'Bash',input:{...}}, {type:'text',text:'B'}]`
- **THEN** the adapter emits one `message` event with `role:
  'assistant'` and `blocks:[{kind:'text',text:'A'}]`
- **AND** one `tool_use` event with `id:'t1'`, `name:'Bash'`, `input:
  {...}`
- **AND** one `message` event with `role: 'assistant'` and
  `blocks:[{kind:'text',text:'B'}]`
- **AND** all three events share the same `ts` and assistant message
  id so the renderer can group them

#### Scenario: Duplicate verbose-mode event

- **WHEN** the adapter reads two `SDKMessage` lines sharing the same
  `uuid`
- **THEN** only the first is emitted as an `AgentResponseEvent`
- **AND** the second is silently skipped

#### Scenario: Tool result correlates to its tool use

- **WHEN** the adapter reads a `user` message whose `content[0].type`
  is `tool_result` with `tool_use_id: 't1'`
- **THEN** the adapter emits a `tool_result` event with `toolUseId:
  't1'`, `ok` derived from `is_error`, and `content` normalised to
  `ResponseBlock[]` (string → one `TextBlock`; structured → JSON
  pretty-printed in a `TextBlock` of mime-tagged code)

#### Scenario: Amp event identical in shape

- **WHEN** the same adapter reads stream-json from a Sourcegraph Amp
  session
- **THEN** the same outputs are produced as for Claude Code

### Requirement: Live update push to the renderer

The backend SHALL push `AgentResponseEvent` to the renderer in the
order events are observed from the file.

#### Scenario: Event payload shape

- **WHEN** the watcher produces an `AgentResponseEvent` `e` for task
  `T`
- **THEN** the main process sends
  `AgentResponseEvent` on the window's webContents with
  `{ taskId: T, agentId, event: e }`

#### Scenario: Renderer order matches file order

- **WHEN** multiple events are produced from the same read
- **THEN** they are sent in the order they appear in the file
- **AND** the renderer's per-task event list preserves that order

### Requirement: Rendering pipeline reuses existing markdown stack

The renderer SHALL render text blocks via the project's existing
`marked + shiki + DOMPurify` pipeline, with an extended sanitiser
configuration scoped to the response panel only.

#### Scenario: Text block

- **WHEN** a `message` event arrives with a `TextBlock`
- **THEN** the renderer passes the text through
  `renderMarkdownForAgentResponse(text, { cwd })`
- **AND** the result is inserted via `innerHTML` after DOMPurify
- **AND** Shiki applies the active theme (`store.themePreset`'s
  `github-dark` / `github-light` selection in
  `src/lib/shiki-highlighter.ts`)

#### Scenario: Mermaid code fence

- **WHEN** a text block contains a `mermaid` code fence
- **THEN** the marked-shiki path emits a `<div class="mermaid-block"
  data-mermaid="...">` placeholder
- **AND** the shared `mermaid-postprocess` helper replaces the
  placeholder's `innerHTML` with the rendered SVG
- **AND** failed renders leave the raw source visible without
  throwing

#### Scenario: Inline image with safe `src`

- **WHEN** a text block contains
  `![alt](file:///<task-cwd>/screen.png)`
- **THEN** the rendered output contains an `<img>` whose `src` is the
  same `file://` URL
- **AND** whose `alt` is `alt`

#### Scenario: Inline image with disallowed `src`

- **WHEN** a text block contains `![x](file:///etc/passwd)` or
  `![x](javascript:alert(1))` or `![x](ftp://server/file)`
- **THEN** the `<img>` is omitted from the rendered output
- **AND** the alt text remains visible as plain text

### Requirement: Tool and thinking blocks are collapsible

The panel SHALL render `tool_use`, `tool_result`, and `thinking`
events as collapsible UI affordances, defaulting to collapsed so the
reading flow is the assistant's prose.

#### Scenario: Tool use is collapsed by default

- **WHEN** a `tool_use` event renders
- **THEN** the panel shows a single-line row with the tool name and a
  one-line truncated input summary
- **AND** clicking the row toggles the full JSON input view

#### Scenario: Tool result attaches to its tool use

- **WHEN** a `tool_result` event arrives whose `toolUseId` matches a
  prior `tool_use` event in the same task
- **THEN** the result row is rendered immediately below the matching
  tool-use row
- **AND** is collapsed by default
- **AND** shows a pass/fail badge derived from `ok`

#### Scenario: Thinking is hidden by default

- **WHEN** a `thinking` event renders
- **THEN** the body is collapsed under a "Thinking…" disclosure
- **AND** expanded text renders in italic muted style

### Requirement: Panel never blocks or replaces the terminal

The panel SHALL coexist with the agent's xterm view and SHALL NOT
interfere with the existing pty lifecycle.

#### Scenario: Opening or closing the panel does not affect the agent

- **WHEN** the user toggles the panel
- **THEN** no IPC is sent to `WriteToAgent`, `KillAgent`, or
  `SpawnAgent`
- **AND** the agent's pty process and xterm buffer are unchanged

#### Scenario: User input still flows through xterm

- **WHEN** the user types into the agent terminal while the panel is
  open
- **THEN** keystrokes are written to the pty as before
- **AND** the panel reflects the resulting assistant response on the
  next tail tick

### Requirement: Watcher lifetime is bounded to the task

The watcher SHALL be torn down when no longer needed and SHALL NOT
leak across task removals or app shutdown.

#### Scenario: Task is removed

- **WHEN** the renderer removes a task whose response watcher is
  active
- **THEN** the renderer sends `StopAgentResponseWatcher` for that
  task before clearing it from the store

#### Scenario: Window is closed

- **WHEN** the main window closes
- **THEN** all active response watchers are closed
- **AND** their file handles released

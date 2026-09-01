# Add Agent Response Rendering

## Why

Today, AI agent terminals in the app are pure `node-pty` + xterm.js
streams. Agents like Claude Code, Codex, and Cursor draw a rich TUI with
ANSI styling, cursor moves, and live redraws. That is great for
interaction but bad for *reading*: markdown tables come through as
pipe-and-dash ASCII, code fences are colorised but not line-numbered or
copyable as blocks, mermaid fences stay as raw source, and image
references render as `[image: /path.png]` literals. Once a task has run
for an hour the scrollback is a wall of styled text that the user has to
re-parse mentally.

Warp's recent release frames the same problem ("no more stray Markdown
formatting to read") and solves it by routing the agent's response
through a markdown renderer instead of the byte stream. We have most of
the rendering plumbing already (`src/lib/marked-shiki.ts`, mermaid
client-side rendering in `PlanViewerDialog.tsx`), but no structured
input to feed it. This change adds that input and a panel to display
it, opt-in per task.

## What changes

- A new per-task **AI Response panel** rendered alongside the existing
  agent terminal, toggled from the terminal toolbar. Default off.
- For agents that publish a structured session log (initial support:
  **Claude Code**, and **Sourcegraph Amp** which uses the same
  stream-json format), the main process tails that log file and
  forwards parsed events to the renderer.
- The panel renders assistant text as markdown (tables, syntax-
  highlighted code via Shiki, mermaid diagrams, sanitised inline
  images), and renders tool calls / tool results as collapsible blocks.
- Agent definitions gain an optional `responseSource` descriptor
  declaring how to discover the structured log. Built-in defaults ship
  for `claude`; custom agents can opt in via `CustomAgentEditor`.
- The existing pty + xterm flow is unchanged. The panel is a *parallel
  reader*; input still goes through the TUI. Agents without a known
  `responseSource` show a one-line "Rich view not available for this
  agent" notice in the panel.

## Impact

- New capability `agent-response-rendering`.
- New IPC channels `StartAgentResponseWatcher`,
  `StopAgentResponseWatcher`, `AgentResponseEvent` in
  `electron/ipc/channels.ts`.
- New shared types in `src/ipc/types.ts`: `AgentResponseSource`,
  `AgentResponseEvent`, `AgentResponseEventPayload`.
- New backend module `electron/ipc/agent-response.ts` (JSONL tailer +
  adapter registry). New npm dependency
  `@anthropic-ai/claude-agent-sdk` (used only as the typed parser for
  the `claude-code-v1` adapter, not invoked as a runtime).
- New frontend module `src/components/AgentResponsePanel.tsx` and a
  small renderer store slice `src/store/agentResponse.ts`.
- Additions to `AgentDef` (`responseSource?: AgentResponseSource`) and
  to `PersistedState` (`agentResponsePanelEnabled?: Record<TaskId,
  boolean>`).
- Extension of `src/lib/marked-shiki.ts` DOMPurify config to allow
  `<img>` with a strict `src` allowlist (`file://` under the task cwd,
  `https://`, `data:image/{png,jpeg,gif,webp}`).
- No change to the existing `SpawnAgent` / `WriteToAgent` IPC contract.
  No change to xterm rendering or scrollback. No change to persistence
  of pty buffers. Non-Claude agents keep working exactly as today.

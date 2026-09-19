# Tasks — Add Agent Response Rendering

## Shared contract

- [ ] Add IPC channels `StartAgentResponseWatcher`,
      `StopAgentResponseWatcher`, `AgentResponseEvent` to
      `electron/ipc/channels.ts` and the preload allowlist.
- [ ] Add shared types to `src/ipc/types.ts`:
      `AgentResponseSource`, `AgentResponseAdapterId`,
      `AgentResponseEvent`, `ResponseBlock`,
      `StartAgentResponseWatcherPayload`,
      `AgentResponseEventPayload`.
- [ ] Extend `AgentDef` in `src/ipc/types.ts` with optional
      `responseSource?: AgentResponseSource`.

## Backend — watcher and adapters

- [ ] Add `@anthropic-ai/claude-agent-sdk` to `dependencies` in
      `package.json`. Used only for its `SDKMessage` types in
      `electron/ipc/agent-response-adapters/claude-code-v1.ts`.
- [ ] Implement `electron/ipc/agent-response.ts`:
      `resolveSourcePath(source, ctx)` (template substitution);
      `openWatcher(path, onLine)` (fs.watch with stat-poll fallback,
      forward-only line buffer keyed by last byte offset);
      `startAgentResponseWatcher` / `stopAgentResponseWatcher`
      handlers; per-task adapter dispatch.
- [ ] Implement adapter
      `electron/ipc/agent-response-adapters/claude-code-v1.ts`:
      raw line → `SDKMessage` (via SDK types) → normalised
      `AgentResponseEvent[]`. De-dupe duplicates by message `uuid`.
      Split assistant `content[]` into one event per block; correlate
      `tool_result` with prior `tool_use` by `tool_use_id`.
- [ ] Inject `--session-id <uuid>` (uuidv4) into the args passed to
      `spawnAgent` in `electron/ipc/pty.ts` when the resolved
      `AgentDef.responseSource?.sessionIdArg` is present. Persist the
      uuid into the in-memory `PtySession` so the watcher can be
      started later with the same id.
- [ ] Built-in agent defaults (in the same place
      `IPC.ListAgents` is resolved): register `responseSource` for
      `claude` and `amp`.
- [ ] Wire `register` calls into `electron/ipc/register.ts`. Watchers
      auto-stop on window unload and on `KillAgent`.
- [ ] Unit tests `electron/ipc/agent-response.test.ts` covering: line
      buffering across partial reads, fs.watch+stat fallback, dedup by
      uuid, adapter mapping for each `SDKMessage` variant, malformed
      JSON lines (drop + log, never throw).

## Frontend — store and panel

- [ ] Add `agentResponsePanelEnabled?: Record<TaskId, boolean>` to
      `PersistedState` and a setter in `src/store/persistence.ts`.
- [ ] New store `src/store/agentResponse.ts`: per-task event log
      (`createStore({ [taskId]: AgentResponseEvent[] })`),
      subscription bookkeeping, `openPanel(taskId)` /
      `closePanel(taskId)` that issue Start/Stop IPC.
- [ ] New `src/components/AgentResponsePanel.tsx`:
      vertical message list, per-event component
      (`MessageText` / `ToolUseBlock` / `ToolResultBlock` /
      `ThinkingBlock` / `ImageBlock`); collapsible tool/thinking by
      default; jump-to-latest / expand-all / collapse-all toolbar
      buttons; copy-thread button (markdown serialisation).
- [ ] Lift mermaid post-process from `PlanViewerDialog.tsx:104-122`
      into a reusable helper `src/lib/mermaid-postprocess.ts`. Reuse
      from the panel and from the existing call sites.
- [ ] In `src/lib/marked-shiki.ts`, export a second variant
      `renderMarkdownForAgentResponse(text, ctx)` that adds
      `src`/`alt`/`title` to `ADD_ATTR` and installs a
      `uponSanitizeAttribute` hook validating `<img src>` against the
      scheme allowlist (`data:image/(png|jpeg|gif|webp)`, `https://`,
      `file://` resolving under `ctx.cwd`).
- [ ] Edit `src/components/TaskAITerminal.tsx`: add a panel-toggle
      button to the toolbar (visible only when
      `task.agent.def.responseSource` is set); render
      `<AgentResponsePanel>` in a vertical split when enabled.
- [ ] Edit `src/components/CustomAgentEditor.tsx`: add an
      "Advanced → Response source" disclosure exposing
      `pathTemplate`, `adapter` (select), and `sessionIdArg.flag`.
- [ ] CSS additions to `src/styles.css` for the response panel: scroll
      container, message bubble, tool-block chrome, image max-width,
      jump-to-latest pill. Reuse the existing `--fg`/`--border` theme
      tokens — no new colour vars.

## Component tests

- [ ] `src/components/AgentResponsePanel.test.tsx` covering:
      initial empty state, single text message render, multi-block
      assistant message ordering, tool_use → tool_result correlation,
      collapsible expand/collapse, mermaid block post-process,
      image-block rendering with allowed/disallowed schemes.
- [ ] `src/store/agentResponse.test.ts` covering: append on event,
      Start/Stop wiring, panel-open persistence round-trip.

## Persistence and migrations

- [ ] Bump `PERSISTED_STATE_VERSION` if present, or add a defaulted
      read for `agentResponsePanelEnabled` so older saved state is
      treated as "no panel open".

## Acceptance / manual smoke

- [ ] Spawn a Claude Code task. Verify panel toggle appears.
      Toggle on. Observe streamed assistant text appearing as
      rendered markdown including tables, mermaid, syntax-highlighted
      code.
- [ ] Have Claude run a tool that returns an image path under the task
      cwd; verify the `<img>` renders. Have it reference a
      `file:///etc/passwd`-style path; verify it is stripped.
- [ ] Close panel, restart app; verify the panel opens again for that
      task on reload.
- [ ] Spawn an Aider task with no `responseSource`; verify the toggle
      button is not shown.
- [ ] Switch task themes (light/dark); verify panel markdown re-paints
      with the right Shiki theme.

## Validation

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `openspec validate --all --strict`

# Qoder CLI as a built-in agent (terminal parity)

Date: 2026-11-20
Status: proposed
Scope: Option A — terminal-agent parity, not full AI-feature parity

## Intent

The user runs Qoder CLI daily and wants the same first-class treatment Claude Code
gets in Parallel Code. Qoder CLI 1.1.93 (verified locally with `qoder --help`)
accepts the same flags and hook protocol that the Claude Code integration already
uses, so this is a small, low-risk addition rather than a new integration.

## Goals

1. Qoder appears in the New task agent picker as a built-in agent (`qoder`).
2. Each Qoder pane owns its session: PC mints `--session-id <uuid>` for a new
   session and resumes with `--resume <uuid>` after a restart.
3. Qoder reports precise status (Working / Needs you / idle) through hooks, using
   the existing `--settings` pipeline and the Claude-compatible hook payloads.
4. Qoder takes part in agent orchestration through `--mcp-config`.
5. Skip permissions passes `--dangerously-skip-permissions`.
6. Reopening a task resumes with `--continue` when no explicit session id exists.
7. Documentation lists Qoder as built-in and records what still differs.

## Non-goals

- Qoder Chat pane (ACP / Qoder Agent SDK).
- Qoder as a provider for Ask about code, Finish review, task naming, cards or
  PR drafts. Those stay Claude / Codex / MiniMax.
- Qoder in the New task model picker.
- Usage / rate-limit panel (Qoder has no verified status-line equivalent).
- Teleport and other Claude-only session features.
- Importing `~/.qoder/agents/*.md` definitions (Option C, a later step).

## Verified compatibility (Qoder CLI 1.1.93)

| Need               | Flag / behaviour                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| New session id     | `--session-id <id>`                                                                                                                               |
| Resume one session | `--resume [id]`                                                                                                                                   |
| Resume latest      | `--continue`                                                                                                                                      |
| Hooks + config     | `--settings <file or inline JSON>`                                                                                                                |
| Hook protocol      | Same event names and stdin JSON as Claude Code (`SessionStart`, `Stop` with `last_assistant_message`, `Notification` with `permission_prompt`, …) |
| MCP                | `--mcp-config <file>` (also `--strict-mcp-config`)                                                                                                |
| Skip permissions   | `--dangerously-skip-permissions` (alias of `--permission-mode bypass_permissions`)                                                                |
| Non-interactive    | `-p`, `-o json` (not used in this option)                                                                                                         |

`--permission-mode dont_ask` is not a bypass: it denies anything that would ask.
Only `bypass_permissions` / `yolo` / `YOLO` / `--yolo` count as bypass.

## Approaches considered

- **A. Terminal-agent parity (chosen).** Built-in agent, sessions, hooks, MCP,
  permissions, docs. Small change; reuses the Codex precedent and the Claude
  hook pipeline.
- **B. Full parity.** A plus Qoder as an AI provider (headless) and an ACP chat
  pane. Large, multi-phase; deferred.
- **C. Import Qoder custom-agent Markdown.** Map `.qoder/agents/*.md` to
  `--agent` / `--agents`. Useful but orthogonal; deferred.

## Design

1. **Agent definition** — `electron/ipc/agents.ts`: add a `qoder` entry to
   `DEFAULT_AGENTS` (command `qoder`, `resume_args: ['--continue']`,
   description). Skip-permission args come from the shared table.
2. **Skip-permissions table** — `electron/shared/skip-permissions.ts`: add
   `qoder` to `SKIP_PERMISSIONS_ARGS` (`--dangerously-skip-permissions`) and to
   `BYPASS_RULES` (`--dangerously-skip-permissions`, `--yolo`, and
   `--permission-mode` valued `bypass_permissions` / `bypassPermissions` /
   `yolo` / `YOLO`). `dont_ask` and `accept_edits` stay non-bypass.
3. **Session ids** — `electron/shared/session-resume.ts`: qoder in
   `newSessionArgs` (`--session-id`), `resumeSessionArgs` (`--resume`),
   `canAssignSessionId` and `canResumeSessionId`.
4. **Launch args** — `src/lib/agent-args.ts`: include qoder in the hidden-agent
   picker switch (`--continue` → `--resume`) and in
   `taskAgentOpensSessionPicker`. `legacyMcpConfigArgs` already falls through to
   `--mcp-config` for unknown commands, so MCP needs no change. Do not add a
   resume-failure retry pattern until Qoder's stale-session message is verified.
5. **Status hooks**
   - `electron/agent-hooks/launch-args.ts`: recognise qoder as
     Claude-compatible for `--settings` injection; never replace a user-provided
     `--settings`.
   - `electron/agent-hooks/server.ts`: expose the existing hooks-only settings
     file as `qoderSettingsPath` (no `statusLine`, because Qoder has no verified
     equivalent). Routes stay `/hook/claude` because the payload shape is
     identical.
   - `electron/ipc/pty.ts`: extend `AgentHookRuntime` with `qoderSettingsPath`;
     `applyAgentHookLaunch` injects hook env and settings for qoder under the
     same exclusions as Claude (shell, Docker). `electron/agent-hooks/runtime.ts`
     wires the new field.
6. **Docs** — `docs/custom-agents.md` (built-in list, status precision, command
   recognition, MCP/permission notes) and `README.md` agent lists; leave
   `docs/market/scorecard.md` to its monthly refresh.
7. **Tests** — add qoder cases to `skip-permissions`, `session-resume`,
   `agent-hooks/launch-args`, `electron/ipc/pty`, `src/lib/agent-args`,
   `electron/mcp/agent-args` and the agents store. No IPC channel changes, so
   the preload allowlist is untouched.

## Verification

- `npm run check` and `npm run test:changed`; focused tests for the files above.
- Manual smoke with the installed Qoder CLI: start a task with a short prompt,
  confirm the prompt is typed and the board moves Working → idle / Needs you;
  restart the app and confirm the same session resumes; tick Skip permissions
  and confirm tool calls do not prompt; run a coordinated task and confirm
  `--mcp-config` is accepted.
- Docker tasks keep terminal-heuristic status (loopback hooks are unreachable),
  matching Claude.
- Real-agent PTY tests are opt-in; report if they are skipped.

## Open questions

- Qoder's TUI input line and any init dialogs: if the generic `❯`/`›` detection
  or the 1.5 s fallback is too early, add `prompt_ready_delay_ms` after
  measurement.
- Whether a `QODER_JOB_DIR` guard is needed in the hook script for background
  workers; unverified, so not added now.

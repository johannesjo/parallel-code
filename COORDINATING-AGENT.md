# Coordinating Agent — Implementation Notes

## Overview

A Claude Code agent running inside a task can now programmatically create and coordinate other tasks in Parallel Code via MCP tools. The coordinating agent can spawn sub-tasks, send prompts, monitor completion, read diffs, and merge results — all without manual human orchestration.

## Architecture

```
Claude Code (coordinating task PTY)
    | MCP stdio (JSON-RPC)
    v
MCP Server Process (electron/mcp/server.ts)
    | HTTP + Bearer token
    v
Electron Remote Server (electron/remote/server.ts)
    | Direct function calls
    v
Orchestrator (electron/mcp/orchestrator.ts)
    | Uses existing backend primitives
    v
PTY / Git / Worktree functions
```

## MCP Tools Available to Coordinating Agents

| Tool              | Description                             |
| ----------------- | --------------------------------------- |
| `create_task`     | Create a new task with worktree + agent |
| `list_tasks`      | List all orchestrated tasks with status |
| `get_task_status` | Get task status + git summary           |
| `send_prompt`     | Send prompt to a task's agent           |
| `wait_for_idle`   | Wait until agent becomes idle           |
| `get_task_diff`   | Get changed files + unified diff        |
| `get_task_output` | Get recent terminal output              |
| `merge_task`      | Merge task branch to main               |
| `close_task`      | Close and clean up a task               |

## Files Created

- `electron/mcp/prompt-detect.ts` — Shared prompt detection (extracted from taskStatus.ts)
- `electron/mcp/types.ts` — Shared types for orchestrator, API, MCP tools
- `electron/mcp/orchestrator.ts` — Main-process task lifecycle management
- `electron/mcp/client.ts` — HTTP client for MCP server -> remote server
- `electron/mcp/server.ts` — Standalone MCP server (stdio transport)
- `src/components/SubTaskStrip.tsx` — Sub-task status chips on coordinator panel

## Files Modified

- `electron/ipc/channels.ts` — MCP IPC channels
- `electron/remote/server.ts` — Orchestrator REST API endpoints
- `electron/ipc/register.ts` — Orchestrator init, MCP IPC handlers
- `src/store/types.ts` — `coordinatorMode`, `coordinatedBy`, `mcpConfigPath` on Task
- `src/store/tasks.ts` — Coordinator task creation, MCP event listeners
- `src/store/taskStatus.ts` — Imports from shared prompt-detect module
- `src/store/persistence.ts` — Persist/restore coordinator fields
- `src/store/store.ts` — Export `initMCPListeners`
- `src/App.tsx` — Initialize MCP listeners
- `src/components/NewTaskDialog.tsx` — "Coordinator mode" checkbox
- `src/components/TaskPanel.tsx` — SubTaskStrip, `--mcp-config` in agent args
- `src/components/Sidebar.tsx` — "via Coordinator" labels on sub-tasks
- `package.json` — Added `@modelcontextprotocol/sdk`, dev build identity

## UI Changes

1. **New Task Dialog** — "Coordinator mode" checkbox after agent selector. When enabled, shows a warning banner and auto-starts the MCP infrastructure on task creation.

2. **Sidebar** — Sub-tasks created by a coordinator show a "via {name}" label below the task name. Clicking the label navigates to the coordinator task.

3. **Task Panel** — Coordinator tasks show a horizontal sub-task status strip between the branch info bar and the notes panel. Each chip shows a StatusDot + task name and is clickable.

---

## Testing

### Build

The build identity has been changed to `com.parallel-code.app.dev` / "Parallel Code Dev" so it installs separately from the production app.

```bash
# From the worktree directory
npm run build
# .dmg is in release/
open release/*.dmg
```

### Test 1: MCP Server Standalone

1. Start the dev app
2. Open Settings, start the remote server (or it auto-starts with coordinator mode)
3. Run the MCP server directly to verify it connects:
   ```bash
   node dist-electron/mcp/server.js --url http://127.0.0.1:7777 --token <token>
   ```
   (The token is printed in the app's remote server settings)
4. Use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) or send JSON-RPC over stdin to call tools like `list_tasks`

### Test 2: Coordinator Task End-to-End

1. Link a project in the app
2. Click "New Task"
3. Check the **"Coordinator mode"** checkbox
4. Enter a prompt like: `Create two tasks: one to add a README.md and one to add a LICENSE file. Wait for both to complete, then merge them.`
5. Submit — the app will:
   - Auto-start the remote server
   - Write a temp MCP config file
   - Spawn Claude Code with `--mcp-config <path>`
6. Verify:
   - Sub-tasks appear in the sidebar with "via {coordinator-name}" labels
   - The coordinator's panel shows a sub-task status strip with chips
   - Clicking a chip navigates to that sub-task
   - The coordinating agent can merge and close sub-tasks

### Test 3: UI Elements

1. Create a coordinator task (as above)
2. Wait for it to create at least one sub-task
3. Check sidebar: sub-task should show "via {name}" in muted text
4. Check coordinator panel: sub-task strip should appear with status dots
5. Click the "via" label — should navigate to coordinator
6. Click a chip in the strip — should navigate to that sub-task

### Test 4: Edge Cases

- Create multiple sub-tasks rapidly
- Close a sub-task while its agent is busy
- Close the coordinator while sub-tasks are still running
- Collapse and uncollapse a coordinator task

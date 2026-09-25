# Runtime separation plan

Status: revised after three reviews (two focused, one adversarial) and re-checked against the code on 2026-09-25. Steps 0, 1, 2 and 3a are done, and 3b is partly done (the runtime state has a home; the handler groups have not moved). Steps 1 and 2 fixed the only known correctness problems; everything from 3b onward is structural and waits for a named product goal (see the checkpoint after step 3). References name functions rather than line numbers, because line numbers drift.

## Why

The desktop renderer is the source of truth for tasks, and the main process co-owns some of their state:

- Agent processes are spawned when `TerminalView` mounts (`startSpawn` in `src/components/TerminalView.tsx`). Agent terminals pass `preserveSessionOnCleanup` (`src/components/TaskAITerminal.tsx`), so unmounting a view does not kill its agent. After a renderer reload, main reattaches the running PTY and replays its scrollback (`attachExisting` in `spawnAgent`, `electron/ipc/pty.ts`). Agents are killed on purpose when a task is collapsed or closed (`collapseTask` and `closeTask` in `src/store/tasks.ts`).
- The renderer persists task state as one JSON blob (`saveState` in `src/store/persistence.ts`). Main also writes that file: it normalizes every renderer save and does its own read-modify-write for delegation state (the `IPC.SaveAppState` handler and the delegation `persist` callback in `electron/ipc/register.ts`; `normalizeState` in `electron/mcp/delegation.ts`).
- The phone and MCP agents reach task, reasoning, mind-map and notes state through the renderer (`callRenderer` in `electron/ipc/register.ts`), with a 120-second timeout. It backs 10 operations: reasoning and mind-map reads and updates, opening the canvas, publishing tours, and the phone's projects, task creation and notes.
- Tasks are created three ways. Desktop and phone tasks go through the renderer store (`createTask` in `src/store/tasks.ts`). Coordinator tasks are created in main (`createTaskUnchecked` in `electron/mcp/coordinator.ts`). Every path provisions the worktree before the task is durably saved. Desktop and phone task creation calls `saveState()` immediately after registering task authority and adding the task to the store, without awaiting the save; coordinator children are saved only after the renderer adopts them. A crash between provisioning and save completion can therefore leave an orphaned worktree. Before step 2, nothing reconciled worktrees at startup, so these orphans went unreported.
- Document workspaces create worktrees in the same `.worktrees/` directory as tasks (`prepareAlternateWorktree` in `electron/documents/runs.ts`). Their records live in document-run state, not `state.json`.
- Question detection and trust-dialog acceptance run in the renderer (`looksLikeQuestion` and `tryAutoTrust` in `src/store/taskStatus.ts`). The coordinator has a separate readiness monitor (`createAgentOutputMonitor` and `scheduleInitialPromptDelivery` in `electron/mcp/coordinator.ts`, a 3,300-line file).
- Until step 1, only xterm in the renderer answered terminal queries. Codex exits if its cursor-position query goes unanswered for about 2 s (commit `1204de82`, patched by disabling `backgroundThrottling` in `electron/main.ts`). Coordinator sub-tasks are spawned in main before any view exists, so they relied on a view mounting in time. This is the only user-facing bug we found in the history that the ownership split caused; the search was by commit message, so others may exist. Step 1 fixed it.
- The coordinator launches children without the `SpawnAgent` IPC handler, but it covers the same concerns its own way: `createTask` counts in-flight children against the concurrency limit and runs its launch guards, and the session MCP provider (`setSessionMcpProvider` in `registerAllHandlers`) registers the canvas agent, ownership and wide bind. Plan and steps watchers start when the renderer adopts the child through the same handler with `attachExisting`, and their first read picks up a plan written before that. An earlier revision called this a correctness gap; it is duplicated logic, not a bug. The only visible difference is that such a plan arrives marked `recovered`, so it does not open the canvas.
- `registerAllHandlers` is a single closure of about 2,100 lines that also runs the remote-server, coordinator and delegation lifecycles.
- Precedent: document workspaces already run headless agents in worktrees from main, with their own records and `reconcileInterrupted` (`electron/documents/runs.ts`). Use them as the template for runtime-owned tasks.

## Target

| Area               | Owns                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Runtime            | Projects, tasks, agent sessions, worktrees, coordination, operational status, durable task state. No Electron, no Solid. |
| Desktop shell      | Windows, menus, dialogs, notifications, updates, native browser views.                                                   |
| UI                 | Rendering, navigation, selection, layout, local drafts.                                                                  |
| Transport adapters | IPC and HTTP/WebSocket validation, commands, subscriptions.                                                              |

Invariant: a task can be created, run, inspected and stopped without a mounted desktop UI. Desktop and phone observe the same runtime-owned state.

Separate ownership first. Add a process boundary only when a goal requires it (step 8).

## Step 0 — Enforce the renderer boundary for type imports (this pass)

dependency-cruiser ignores `import type` today, so `no-renderer-importing-main` does not see type-only imports from `src/` into `electron/`. Enabling `tsPreCompilationDeps` exposes 13 existing violations.

1. Allowlist the three pure type modules the renderer already relies on: `electron/remote/protocol.ts`, `electron/ipc/shared-types.ts` and `electron/documents/types.ts`. None imports Node or Electron. → verify: `npm run lint:arch`.
2. Move `UpdateStatus` out of `electron/ipc/updater.ts`, which imports Electron, into `electron/ipc/shared-types.ts`. → verify: `npm run typecheck` and `npm run compile`.
3. Break the type-only cycle between `DocumentViewer.tsx` and `PageBlocks.tsx` (`BlockRange`). → verify: `npm run lint:arch`.
4. → verify: `npm run check`, `npm run check:static`, `npm test`.

This is static only and makes the existing renderer/main rule mean what it says. It is also a prerequisite for the runtime rule in step 3.

## Later steps, in dependency order

Each of these changes runtime behavior and needs a smoke test in the real app.

1. **Terminal-query responder (done).** Every PTY session keeps a headless xterm mirror in main (`electron/ipc/terminal-query-responder.ts`), fed the process output and resized with the PTY. It answers cursor-position queries (`CSI 6 n`, `CSI ? 6 n`) itself. The renderer's xterm no longer answers them (`src/lib/terminalQueries.ts`), so there is exactly one answer, whether a view is mounted, hidden, reloading or blocked by an automation write. This design was chosen over attach/detach tracking because it also covers hidden, throttled views and stale replies to replayed scrollback. Banners and replayed scrollback are parsed without answering, so the mirror's cursor matches the pane. Device-attribute, color and keyboard queries still come from the renderer, because the answers depend on its theme and settings and their order matters. Verified: a real-PTY program that exits when its cursor query goes unanswered for 2 s runs with no renderer; with the reply disabled, it fails.
2. **Startup worktree reconciliation (done).** `createTask` in `electron/ipc/tasks.ts`, which desktop, phone and coordinator tasks all go through, writes an intent to a main-owned journal (`worktree-intents.json` in the user data directory, written with `atomicWriteFileSync`) before provisioning. The `SaveAppState` handler drops intents once a saved state claims their worktree path. At startup, before the window exists, `reconcileWorktreeIntents` (`electron/ipc/worktree-intents.ts`) reports every intent whose worktree still exists but no saved task claims. Nothing is deleted, because the worktree may hold user work. An orphan is reported on each start until its worktree is removed.
   - Journal rather than a `git worktree list` scan: a dev run and an installed build share repositories but not state, and Arena and document-run worktrees share `.worktrees/` without being tasks. A scan would report all of them. The journal reports only this instance's own interrupted creations.
   - Matching is by worktree path, so a later branch adoption does not matter.
   - A journal read or write failure is logged and never blocks startup, task creation or saving.
   - Orphans are logged under the `worktrees` category only. Showing them in the UI is follow-up work.
   - Limits: it cannot find orphans created before the journal existed, or worktrees left behind for other reasons, such as a failed removal.
   - Verified: `electron/ipc/worktree-intents.test.ts` simulates a crash between provisioning and save and sees the orphan on the next start. `electron/ipc/tasks.test.ts` checks that the intent is written before `createWorktree` runs; it fails if the order is reversed. The journal is intended as the first part of the step 5 registry.
3. **Runtime boundary, then split `registerAllHandlers`.** Two independent changes; land 3a first.

   **3a. Notify port (done).** `pty.ts`, `git.ts`, `plans.ts`, `steps.ts` and the coordinator take a `Notify` function (`electron/ipc/notify.ts`) instead of a `BrowserWindow`, and none of them imports Electron. `registerAllHandlers` builds one with `windowNotifier` (`electron/ipc/window-notifier.ts`), which drops messages once the window is destroyed; the coordinator's `setWindow` became `setNotify`. The coordinator still refuses to launch before a notifier is set; step 4 decides whether a no-op notifier is enough for headless launches. One behavior moved: the steps watcher still reads the steps file after the window is destroyed, and only the send is dropped. Verified: `npm run check`, `lint:arch`, the unit suite and the real-PTY coordinator test.

   **3b. Split `register.ts`.** #279 (pooled workspaces) was closed without merging on 2026-09-25, so it no longer blocks this. 5 of the 12 open PRs touch `register.ts` (#262, #248, #247, #162, #23). Do the split between merges, after announcing a short freeze; it does not block anything before step 4. Before the split:
   - Commit a wiring test against the old code. It records every `ipcMain.handle` channel, throws on duplicates, asserts the `win.on` events and exactly one registration-time `onPtyEvent('exit')`, and triggers `ensureCoordinator` twice so the lazily registered `MCP_*` handlers are seen exactly once.

   Progress:
   - Done: the wiring test (`electron/ipc/register-wiring.test.ts`).
   - Done: `electron/ipc/remote-transport.ts` owns the remote server and the rules for who started it and when it stops.
   - Done: `electron/ipc/mcp-paths.ts` holds `hostMcpServerPath()`, replacing five copies.
   - Done: `electron/ipc/mcp-runtime.ts` owns the transport, the lazy coordinator, delegation, `prepareDelegationParent`, the PTY exit cleanup, and `pendingSpawns`, `canvasOwners` and `wideBindAgents`. `register.ts` reads the coordinator through `mcp.coordinator()` and the server through `transport.current()`. This is the home step 4 needed. The wiring test passed unchanged after each move.
   - Not done: moving the handler groups out of `register.ts`, which is mechanical, one commit per group. The doc and comment updates and the `electron/runtime/` rule below belong to that stage.

   Design rules from review:
   - Mutations of remote-server and coordinator state stay inside `remote-transport` and `mcp-runtime` methods (`startRemoteAccess`, `stopRemoteAccess`, `ensureCoordinator`). `transport.current()` and `mcp.coordinator()` are methods, never destructurable fields, so callers cannot capture a stale `null`.
   - MCP path helpers move into `mcp-runtime.ts` or `mcp-paths.ts`, including one `hostMcpServerPath()` in place of five copies, so no `register-*` module is imported by the runtime.
   - Late-bound callbacks are created per `registerAllHandlers` call, and `coordinatorHandlersRegistered` lives in that closure.
   - Hoisted `function` declarations stay hoisted.
   - No Electron API access at module scope.
   - The coordinator import stays lazy.
   - `DelegationRequest` and `CheckPathExists` need an explicit home.
   - Add the new files to the Semgrep scopes (Arena `writeFileSync`, the two `copyFileSync` sites; keep `nosemgrep` on the same line), and keep `register.ts` in scope.
   - Update `AGENTS.md:39`, `electron/ipc/git.ts:906`, `docs/design-doc.md:69` and the comments in `src/store/remoteStatusSync.ts`, `src/store/remoteTaskHandler.ts` and `electron/ipc/pr-checks.ts`.
   - Keep new files flat in `electron/ipc/` because of the `import.meta.url` path depth.
   - Review the diff with `git diff --color-moved`.

   After the split, add `electron/runtime/` with a dependency-cruiser rule that uses `reachable: true`, because a direct-import rule misses transitive Electron imports. → verify: the wiring test passes unchanged, `npm run check:static`, and a smoke test of desktop, phone and coordinator flows in the real app.

   **Checkpoint (reached after 3a).** Reassess 3b and every later step against a named product goal, such as the phone creating tasks while the renderer is not running. None of them fixes a known bug.

4. **Main-side agent launch.** Structural: it removes duplication between the IPC and coordinator launch paths and is a prerequisite for step 6. Do it together with step 6. The state the `SpawnAgent` handler depends on (`pendingSpawns`, `canvasOwners`, `wideBindAgents`, the transport, `delegation`, the coordinator) now lives in `createMcpRuntime` (`electron/ipc/mcp-runtime.ts`), so `launchAgent()` can take the runtime as input instead of reading the `registerAllHandlers` closure. Moving the other handler groups out of `register.ts` is not a prerequisite.
   - **4a. `launchAgent()`.** Extract the `SpawnAgent` handler body, used by both IPC and the coordinator. The coordinator path keeps what is specific to it: preamble injection, the per-task MCP config file for Docker, the legacy subtask token and container arguments. Move `buildTaskAgentArgs` into shared code; it takes a renderer `Task` and imports from `src/documents/`, so it first needs a narrower input type.
   - **4b. `PromptDeliverer`.** Merge the renderer's question and trust detection (`src/store/taskStatus.ts`) with the coordinator's output monitor into one main-side deliverer instead of adding a third. It could read the step 1 terminal mirror's screen instead of the raw output tail; this is untested. Plan it separately: it is larger and needs real-app smoke tests.

   Decided (2026-09-25):
   - **Agent lifetime.** Collapsing a task keeps its current meaning: it stops the task's agents and saves their session IDs so expanding resumes them. Coordinator children cannot be collapsed.
   - **Settings source.** Main reads `autoTrustFolders` from each renderer save, as it already parses them. A toggle takes effect after the next autosave (1–5 s); no new IPC channel.

   → verify: the existing IPC and coordinator launch tests pass against `launchAgent()`, and the question and trust tests pass against `PromptDeliverer`. Smoke-test a desktop task and a coordinator child in the real app.

5. **Runtime task registry.** Main writes task records it creates and reconciles them at startup. It grows out of the step 2 intent records, and its effect on `state.json` goes through the existing `normalizeState` overlay rather than a second writer with no ordering. → verify: a coordinator child survives a crash before the renderer adopts it and reappears on the next start.
6. **One task-creation path.** `TaskRuntime.createTask(spec)` provisions, registers authority, launches, delivers the prompt, records the task and emits `TaskCreated`. The renderer adopts the task with `attachExisting`, generalizing `MCP_TaskCreated`. The phone stops using `callRenderer` for creation. → verify: one test per origin (desktop, phone, coordinator) goes through `createTask` and ends with the same durable record and `TaskCreated` event.
7. **Runtime-owned task state.** Split `state.json` into runtime task state and UI layout, with versioning and a downgrade path. Remove the remaining `callRenderer` uses. This is the riskiest step and no current requirement needs it. Do it only when a named goal does, as with step 8. → verify: a migration test round-trips old state through upgrade and downgrade, and phone and MCP operations work with no window open.
8. **Separate runtime process.** Only needed if agents must survive app exit or update, the phone must work without Electron, or execution moves to another machine.

## Deferred: typed IPC contracts

`invoke<T>` lets every caller choose its result type, but the history shows no bugs from mismatched types. The task store has about 7 explicit `invoke<T>` calls and already uses the shared result types. A contract on the renderer side only moves the casts into one file.

Do this only together with a compile-only `handleContract` on the main side (after step 3b), so that both ends are checked. Design notes from review:

- Mocked `invoke` takes the last overload's types, so client tests need a `LooseInvoke` type.
- `fireAndForget` and `CHANNELS` in `src/store/usage.ts` pass variables of type `IPC`, so a private `invokeUnchecked` is needed.
- Channels without arguments use `[args?: undefined]`.
- Key the contract by manifest name and remap it to channel values, so a mistyped key fails to compile.
- Arguments must be JSON-safe; exclude channels that take a `Channel<T>`.
- Put the type test in `src/lib/ipc-contract.test.ts` with described `@ts-expect-error` directives.

## Alternatives considered

- **Split only `register.ts`.** Cheap, but it leaves every ownership problem in place and conflicts with 5 open PRs. It is kept as step 3b.
- **Move straight to a separate runtime process.** That adds reconnect, shutdown and protocol work before ownership is untangled. It is deferred to step 8.
- **Move shared contracts out of `electron/`.** `electron/shared/` already acts as the shared package (21 of the 31 `electron/` modules imported by `src/` live there). Moving everything would touch about 180 files for little gain.

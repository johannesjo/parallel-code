# Steps Tracking Specification

## Purpose

Give users a compact, structured progress timeline for each running AI agent so
they can see at a glance what the agent has done and is doing now, without
reading through raw terminal scrollback.

## Requirements

### Requirement: Opt-in per task with remembered default

Steps tracking SHALL be opt-in on a per-task basis, with a persistent app-level
default that the new-task dialog uses to pre-fill the checkbox.

#### Scenario: New task dialog reflects the last-used default

- **WHEN** the user opens the new-task dialog
- **THEN** the "Steps tracking" checkbox is pre-checked if and only if the
  persisted `showSteps` app-level flag is true

#### Scenario: Default updates when user toggles the checkbox

- **WHEN** the user creates a task with the checkbox in the opposite state
- **THEN** the persisted `showSteps` app-level flag is updated to match
- **AND** the next new-task dialog uses that value as the default

#### Scenario: `stepsEnabled` is per-task and persisted

- **WHEN** a task is created with the checkbox enabled
- **THEN** the task's `stepsEnabled` flag is stored on the `PersistedTask`
- **AND** on app restart the flag is restored together with the task

### Requirement: Prompt injection when enabled

When a task is started with `stepsEnabled`, the system SHALL append a standard
steps instruction to the user's initial prompt so the agent knows where and
how to write step entries, while preserving the user's original prompt text.

#### Scenario: Instruction is appended to the prompt

- **WHEN** a task with `stepsEnabled` is spawned
- **THEN** the prompt sent to the agent is the user's original prompt
  followed by `\n\n---\n` and the standard steps instruction
- **AND** the instruction tells the agent to write `.claude/steps.json`, the
  append-only JSON array format, the summary length limit, the allowed
  status values, and to pause and wait for user input after writing a step
  whose status is `awaiting_review`

#### Scenario: Original prompt is preserved

- **WHEN** the task is persisted
- **THEN** the original user prompt is stored as `savedInitialPrompt`
  separately from the injected version

#### Scenario: Instruction is not injected when disabled

- **WHEN** a task with `stepsEnabled` false is spawned
- **THEN** the prompt sent to the agent is exactly what the user typed, with
  no separator or instruction appended

### Requirement: Step entry format

The steps file SHALL be a JSON array of step entry objects. The app SHALL
treat the file as append-only: it never rewrites existing entries on the
agent's behalf, and it expects new entries to appear only at the end.

#### Scenario: Valid step entry shape

- **WHEN** the app accepts a step entry
- **THEN** the entry has `summary` (string, agent-enforced to ≤ 60 chars),
  `status` (one of `starting`, `investigating`, `implementing`, `testing`,
  `awaiting_review`, `done`), and `timestamp` (ISO 8601 string)
- **AND** MAY have `detail` (string) and `files_touched` (array of
  worktree-relative paths the agent wrote or modified in this step)

#### Scenario: Renderer tolerates timestamps without a timezone

- **WHEN** a step entry's `timestamp` has no timezone suffix
- **THEN** the renderer treats it as UTC for display purposes
- **AND** timestamps emitted by the app itself always include a UTC suffix

### Requirement: Backend file watching with debounce

The main process SHALL watch each task's `.claude/` directory (not the
individual file) for changes, debounce rapid writes, and push updates to the
renderer through IPC.

#### Scenario: `.claude/` already exists at spawn

- **WHEN** a task with `stepsEnabled` is spawned and `.claude/` is already
  present in the worktree
- **THEN** the main process attaches an `fs.watch` on `.claude/`

#### Scenario: `.claude/` does not exist yet

- **WHEN** a task with `stepsEnabled` is spawned and `.claude/` does not exist
- **THEN** the main process watches the worktree root
- **AND** filters events for the `.claude` filename
- **AND** when `.claude/` appears, closes the root watcher and attaches a new
  watcher on `.claude/`
- **AND** if `steps.json` already exists at swap time, performs an immediate
  read

#### Scenario: Only `steps.json` triggers reads

- **WHEN** the watcher fires with a `filename` that is not `steps.json`
- **THEN** the event is ignored
- **AND** when the platform provides a `null` filename, every event triggers
  a read (platform fallback)

#### Scenario: Rapid writes are debounced

- **WHEN** multiple change events fire within 200 ms
- **THEN** the watcher schedules one read 200 ms after the last event
- **AND** only one `StepsContent` IPC push is emitted

#### Scenario: Initial read handles the startup race

- **WHEN** the watcher is first attached
- **THEN** the main process immediately reads `steps.json` if it exists and
  sends a `StepsContent` push so steps written before the watcher was ready
  are not missed

#### Scenario: Read errors are handled gracefully

- **WHEN** reading `steps.json` fails with `ENOENT`
- **THEN** the main process silently pushes `steps: null` and continues
  watching
- **AND** other read errors are logged and produce a `steps: null` push

### Requirement: IPC contract for steps

The system SHALL communicate step updates through dedicated IPC channels
declared in `electron/ipc/channels.ts` and allowlisted in the preload.

#### Scenario: Push channel for live updates

- **WHEN** the watcher produces a new step array
- **THEN** the main process sends `StepsContent` with payload
  `{ taskId, steps }` on the task's window's webContents

#### Scenario: One-shot read for restore

- **WHEN** the renderer sends `ReadStepsContent` with a `worktreePath`
- **THEN** the main process reads `steps.json` once and returns the parsed
  array or `null`

#### Scenario: Watcher teardown

- **WHEN** the renderer sends `StopStepsWatcher` for a task
- **THEN** the main process closes the `fs.watch` handle, clears the debounce
  timer, and removes the entry from the watcher map
- **AND** a second `StopStepsWatcher` for the same task is a no-op

#### Scenario: Watcher stops on task lifecycle events

- **WHEN** a task is closed, collapsed, or removed from the store
- **THEN** the renderer calls `StopStepsWatcher` for that task
- **AND** on app shutdown the main process stops every remaining watcher

### Requirement: Frontend validation and rendering

The renderer SHALL apply only loose validation to accepted step entries so
forward-compatible fields do not break older clients, and SHALL render a
two-zone timeline inside the task panel.

#### Scenario: Loose validation filters entries

- **WHEN** the renderer receives a `StepsContent` payload
- **THEN** every array entry that is a non-null object is retained as a
  `StepEntry`
- **AND** entries that are `null`, arrays, or primitives are dropped
- **AND** unknown fields are preserved but ignored by the renderer

#### Scenario: Two-zone timeline layout

- **WHEN** a task has at least one step entry
- **THEN** the panel renders a collapsible history zone with index, status
  badge, summary, duration between steps, and file count
- **AND** renders an always-expanded latest-step zone with status badge,
  summary, relative timestamp, detail text, and file badges

#### Scenario: Waiting indicator after user input

- **WHEN** the user has sent terminal input to the task since the last step
  entry was written and no new step entry has arrived
- **THEN** the timeline shows a pulsing "Waiting for next step" indicator
- **AND** the indicator clears as soon as a new step entry arrives

#### Scenario: Keyboard navigation through history

- **WHEN** the timeline has keyboard focus
- **THEN** Arrow keys move selection one history entry at a time
- **AND** Page Up and Page Down move selection one page at a time

### Requirement: Panel integration

The task panel SHALL include the steps section as a conditional, resizable
child only when `stepsEnabled` is true.

#### Scenario: Panel sizes

- **WHEN** `stepsEnabled` is true and no steps have arrived yet
- **THEN** the steps section renders at 28 px (header only)
- **AND** expands to 110 px once the first step arrives

#### Scenario: Panel hidden when disabled

- **WHEN** `stepsEnabled` is false
- **THEN** the steps section is not mounted as a `PanelChild`

### Requirement: Git exclusion for steps files

The steps file SHALL be excluded from git through `.git/info/exclude` (local,
per-worktree), never via a committed `.gitignore`, and the exclusion SHALL
work for both normal and linked worktrees.

#### Scenario: Normal worktree

- **WHEN** a task with `stepsEnabled` starts in a normal git worktree
- **THEN** `.claude/steps.json` is appended to `.git/info/exclude` if not
  already present

#### Scenario: Linked worktree

- **WHEN** the worktree has a `.git` file (linked worktree) rather than a
  directory
- **THEN** the main process reads the file, parses its `gitdir:` pointer, and
  appends the exclusion to the pointed-to `info/exclude`

#### Scenario: Idempotent exclusion

- **WHEN** `.claude/steps.json` is already listed in `info/exclude`
- **THEN** no duplicate line is appended

#### Scenario: Steps file is never committed

- **WHEN** the user runs `git status` inside the worktree
- **THEN** `.claude/steps.json` does not appear as an untracked or modified
  file

### Requirement: Steps content is not persisted

Step content itself SHALL NOT be persisted in the app's store; it SHALL be
read fresh from disk on app restart for each task whose `stepsEnabled` is
true.

#### Scenario: Restore on startup

- **WHEN** the app starts and loads persisted tasks
- **THEN** for each task with `stepsEnabled` true the renderer issues a
  `ReadStepsContent` for the worktree path
- **AND** populates the task's in-memory `stepsContent` from the response

#### Scenario: Store does not hold steps across restart

- **WHEN** the app is closed and reopened
- **THEN** the persisted store does not contain any `stepsContent` field

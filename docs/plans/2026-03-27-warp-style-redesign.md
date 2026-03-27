# Warp-Style UI Redesign

## Goal

Transform Parallel Code from a multi-panel developer tool into a Warp-inspired terminal-first experience. Each task is a full-screen terminal with management via a header tab bar and sidebar. Simplify task creation to a single prompt input with hardcoded defaults.

## Design

### 1. Header Tab Bar

New horizontal tab bar between the macOS titlebar and the terminal content area.

**Tab contents:**
- Status dot (running/idle/ready/error)
- Task name (auto-derived from first ~50 chars of prompt, truncated)
- Chevron dropdown trigger

**Tab dropdown menu:**
- Create PR (`gh pr create` in task worktree)
- Open PR in browser (`gh pr view --web`)
- Push to remote
- Merge to main (squash)
- Rebase onto main
- Open worktree in editor
- ---
- Close task (kill agent, remove worktree + branch)

**`+` button** at end of tab bar — inline prompt input, not a dialog. Type prompt, Enter creates task.

### 2. Task Panel — Terminal Only

**Remove from TaskPanel:**
- TaskBranchInfoBar
- TaskNotesPanel
- ChangedFilesList
- PromptInput
- TaskShellSection

**What remains:** xterm.js terminal filling 100% of panel width and height. No chrome, no padding.

**Task creation flow:**
1. Click `+`, type prompt, Enter
2. Backend creates worktree from main, symlinks dependencies
3. Claude Code spawns with `--dangerously-skip-permissions` + prompt
4. Terminal appears in new tab, full-size

**Splitting:** Multiple tasks tile horizontally. Drag divider to resize. Each header tab = one tiled panel.

### 3. Hardcoded Task Defaults

- Agent: Claude Code (always)
- Git isolation: worktree (always)
- Base branch: main (always)
- Permissions: `--dangerously-skip-permissions` (always)
- Symlinks: `node_modules` + gitignored dirs (always)
- No direct mode
- No agent selection
- No git isolation selection

### 4. Color Palette — Warp-Inspired

Replace all 7 themes with a single dark theme:

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | `#0e0e10` | App background |
| `--bg-elevated` | `#1a1a1e` | Sidebar, tab bar |
| `--task-panel-bg` | `#131315` | Terminal panel bg |
| `--bg-input` | `#1e1e22` | Input fields |
| `--bg-hover` | `#252529` | Hover states |
| `--bg-selected` | `#2a2a30` | Selected items |
| `--border` | `#2a2a2e` | Standard borders |
| `--border-subtle` | `#1f1f23` | Faint dividers |
| `--fg` | `#e4e4e8` | Primary text |
| `--fg-muted` | `#9b9ba4` | Secondary text |
| `--fg-subtle` | `#5c5c66` | Disabled/tertiary |
| `--accent` | `#6e56cf` | Primary accent (purple) |
| `--accent-hover` | `#7c66d9` | Accent hover |
| `--success` | `#30a46c` | Success/ready |
| `--error` | `#e5484d` | Error |
| `--warning` | `#f5a623` | Warning/running |

Terminal background: `#131315` (matching panel bg).

Typography unchanged: Sora (UI), JetBrains Mono (terminal).

**Remove:** Theme picker from settings, all `html[data-look]` CSS blocks, `look.ts` preset system.

### 5. Sidebar Changes

**Keep:**
- Projects section (add/remove/edit)
- Task list grouped by project with status dots
- Progress section (completed today, merged lines)
- Connect Phone, Arena buttons
- Resizable width

**Remove:**
- Collapsed task concept (no collapse/uncollapse, tasks are open or closed)

**Change:**
- Click task in sidebar → makes visible in tile view + focuses
- "New Task" button focuses the `+` in header tab bar

### 6. Worktree Reliability

- Audit symlink creation in `git.ts` for edge cases (missing dirs, stale symlinks, permissions)
- Add clear error messages for symlink failures
- Ensure `.claude/settings.local.json` stays per-worktree
- Handle partially-created worktrees in cleanup

## Components Affected

### Remove entirely:
- `TaskBranchInfoBar.tsx`
- `TaskNotesPanel.tsx` (or notes portion of TaskPanel)
- `ChangedFilesList.tsx`
- `PromptInput.tsx`
- `TaskShellSection.tsx`
- `DiffViewerDialog.tsx`
- `PlanViewerDialog.tsx`
- `NewTaskDialog.tsx` (replaced by inline tab bar input)
- `CloseTaskDialog.tsx` (close happens directly from tab dropdown)
- `look.ts` (theme presets)
- Theme-related CSS in `styles.css` (all `html[data-look]` blocks)

### Add new:
- `HeaderTabBar.tsx` — tab bar with task tabs, dropdowns, `+` button
- `TabDropdownMenu.tsx` — per-task action menu
- `InlineTaskCreate.tsx` — prompt input in the `+` tab position

### Modify:
- `TaskPanel.tsx` — strip to terminal-only
- `App.tsx` — new layout structure with header tab bar
- `styles.css` — single Warp theme, remove all preset blocks
- `TilingLayout.tsx` — simplified (no placeholder, no shell sections)
- `Sidebar.tsx` — remove collapsed tasks, simplify new task flow
- `store/tasks.ts` — hardcode defaults, remove options
- `store/types.ts` — simplify Task type, remove unused fields
- `store/ui.ts` — remove theme preset, simplify settings
- `electron/ipc/register.ts` — add PR creation/open handlers
- `electron/ipc/git.ts` — worktree symlink fixes, add PR helpers
- `electron/ipc/channels.ts` — add PR channels

### Backend additions:
- `IPC.CreatePR` — runs `gh pr create` in worktree, returns PR URL
- `IPC.OpenPR` — runs `gh pr view --web` to open in browser

## Layout

```
+-- macOS titlebar (traffic lights, drag region) ----------------+
|-- Header Tab Bar ----------------------------------------------|
|  [● fix auth bug ▾] [● add tests ▾] [+]                      |
|---------------------------------------------------------------|
| Sidebar  |  Terminal Panel 1    |  Terminal Panel 2            |
| (exists  |  (100% terminal)     |  (100% terminal)             |
|  as-is)  |                      |                              |
|          |  > _                 |  > _                         |
|          |                      |                              |
+----------+----------------------+------------------------------+
```

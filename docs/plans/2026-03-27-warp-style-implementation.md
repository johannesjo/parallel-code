# Warp-Style UI Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Parallel Code into a Warp-inspired terminal-first app with header tabs, full-screen terminals, simplified task creation, and a single dark theme.

**Architecture:** Replace the per-panel chrome (notes, prompt input, branch info, shell tabs) with a header tab bar that holds task actions in dropdowns. Each task panel becomes a single full-height xterm.js terminal. The 7-theme system collapses to one Warp-inspired dark palette. Task creation hardcodes Claude Code + worktree + main branch + skip-permissions.

**Tech Stack:** SolidJS, TypeScript, xterm.js, Electron IPC, CSS custom properties

---

### Task 1: Single Warp Theme — Replace All Theme Presets

**Files:**
- Modify: `src/styles.css:1-310` (replace all `html[data-look]` blocks with single theme)
- Modify: `src/lib/look.ts` (reduce to single preset)
- Modify: `src/lib/theme.ts` (if it references presets)
- Modify: `src/components/TerminalView.tsx` (terminal background colors)

**Step 1: Replace CSS theme system**

In `src/styles.css`, replace the `:root` block (lines 5-46) and all `html[data-look='...']` blocks (lines 110-307) with a single `:root` block:

```css
:root {
  --font-ui: 'Sora', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-display: 'Space Grotesk', 'Sora', sans-serif;
  --font-mono:
    'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
    monospace;

  --bg: #0e0e10;
  --bg-elevated: #1a1a1e;
  --bg-input: #1e1e22;
  --bg-hover: #252529;
  --bg-selected: #2a2a30;
  --bg-selected-subtle: #2a2a3040;

  --border: #2a2a2e;
  --border-subtle: #1f1f23;
  --border-focus: #6e56cf;

  --fg: #e4e4e8;
  --fg-muted: #9b9ba4;
  --fg-subtle: #5c5c66;

  --accent: #6e56cf;
  --accent-hover: #7c66d9;
  --accent-text: #ffffff;
  --link: #8b7ade;

  --success: #30a46c;
  --error: #e5484d;
  --warning: #f5a623;

  --island-bg: #1a1a1e;
  --island-border: #2a2a2e;
  --island-radius: 12px;
  --task-container-bg: #131315;
  --task-panel-bg: #131315;

  --shadow-soft: 0 14px 30px rgba(0, 0, 0, 0.4);
  --shadow-pop:
    0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent),
    0 14px 36px color-mix(in srgb, var(--accent) 16%, transparent);
}
```

Also update `html, body, #root` background to `#0a0a0c`.

**Step 2: Simplify look.ts**

Replace `src/lib/look.ts` entirely:

```typescript
export type LookPreset = 'warp';

export const LOOK_PRESETS = [
  { id: 'warp' as const, label: 'Warp', description: 'Dark theme with purple accents' },
];

export function isLookPreset(value: unknown): value is LookPreset {
  return value === 'warp';
}
```

**Step 3: Update terminal background colors**

In `src/components/TerminalView.tsx`, find the `terminalBackground` object (or `getTerminalTheme` function) and replace all preset backgrounds with a single value: `#131315`.

**Step 4: Remove data-look attribute usage**

In `src/App.tsx:643`, change `data-look={store.themePreset}` to remove it entirely (or keep as `data-look="warp"`). Remove all `html[data-look='...']` CSS selectors.

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (or note any LookPreset reference errors to fix)

**Step 6: Commit**

```bash
git add src/styles.css src/lib/look.ts src/components/TerminalView.tsx src/App.tsx
git commit -m "feat: replace 7 themes with single Warp-inspired dark theme"
```

---

### Task 2: Strip TaskPanel to Terminal-Only

**Files:**
- Modify: `src/components/TaskPanel.tsx` (remove all sub-panels except AI terminal)
- Modify: `src/store/types.ts` (clean up Task interface)

**Step 1: Gut TaskPanel**

Replace the `ResizablePanel` children array in `TaskPanel.tsx:237-247` to only include the AI terminal. Remove all the panel builder functions except `aiTerminal()`. Remove unused imports (TaskBranchInfoBar, TaskNotesPanel, TaskShellSection, PromptInput, ScalablePanel, CloseTaskDialog, DiffViewerDialog, PlanViewerDialog, EditProjectDialog, PushDialog, MergeDialog). Remove all dialog state signals (showCloseConfirm, showMergeConfirm, showPushConfirm, pushSuccess, pushing, diffScrollTarget, editingProjectId, planFullscreen).

The component should become roughly:

```tsx
import { createEffect, onMount, onCleanup } from 'solid-js';
import { store, setActiveTask } from '../store/store';
import { TaskAITerminal } from './TaskAITerminal';
import { TaskClosingOverlay } from './TaskClosingOverlay';
import { retryCloseTask } from '../store/store';
import type { Task } from '../store/types';

interface TaskPanelProps {
  task: Task;
  isActive: boolean;
}

export function TaskPanel(props: TaskPanelProps) {
  let panelRef!: HTMLDivElement;

  return (
    <div
      ref={panelRef}
      class={`task-column ${props.isActive ? 'active' : ''}`}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: 'var(--task-container-bg)',
        overflow: 'clip',
        position: 'relative',
      }}
      onClick={() => setActiveTask(props.task.id)}
    >
      <TaskClosingOverlay
        closingStatus={props.task.closingStatus}
        closingError={props.task.closingError}
        onRetry={() => retryCloseTask(props.task.id)}
      />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <TaskAITerminal task={props.task} isActive={props.isActive} />
      </div>
    </div>
  );
}
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: Errors about unused imports in other files referencing removed components — note these for later cleanup but the core panel should compile.

**Step 3: Commit**

```bash
git add src/components/TaskPanel.tsx
git commit -m "feat: strip TaskPanel to terminal-only (remove notes, prompt, branch info, shell tabs)"
```

---

### Task 3: Build Header Tab Bar Component

**Files:**
- Create: `src/components/HeaderTabBar.tsx`
- Create: `src/components/TabDropdownMenu.tsx`
- Modify: `src/App.tsx:667-712` (insert HeaderTabBar between titlebar spacer and main content)

**Step 1: Create TabDropdownMenu**

Create `src/components/TabDropdownMenu.tsx`:

```tsx
import { createSignal, Show, onCleanup, onMount } from 'solid-js';
import { invoke, Channel } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, showNotification } from '../store/store';
import { closeTask, mergeTask } from '../store/tasks';
import type { Task } from '../store/types';

interface TabDropdownMenuProps {
  task: Task;
  onClose: () => void;
}

export function TabDropdownMenu(props: TabDropdownMenuProps) {
  let menuRef!: HTMLDivElement;

  const project = () => store.projects.find((p) => p.id === props.task.projectId);

  onMount(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef && !menuRef.contains(e.target as Node)) {
        props.onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    onCleanup(() => document.removeEventListener('mousedown', handler));
  });

  async function handleCreatePR() {
    try {
      const channel = new Channel<string>();
      channel.onmessage = () => {}; // consume output
      await invoke(IPC.CreatePR, {
        worktreePath: props.task.worktreePath,
        onOutput: channel,
      });
      showNotification('PR created');
    } catch (err) {
      showNotification(`PR creation failed: ${err}`);
    }
    props.onClose();
  }

  async function handleOpenPR() {
    try {
      await invoke(IPC.OpenPR, { worktreePath: props.task.worktreePath });
    } catch (err) {
      showNotification(`Could not open PR: ${err}`);
    }
    props.onClose();
  }

  async function handlePush() {
    try {
      const channel = new Channel<string>();
      channel.onmessage = () => {};
      await invoke(IPC.PushTask, {
        worktreePath: props.task.worktreePath,
        branchName: props.task.branchName,
        onOutput: channel,
      });
      showNotification('Pushed to remote');
    } catch (err) {
      showNotification(`Push failed: ${err}`);
    }
    props.onClose();
  }

  async function handleMerge() {
    try {
      await mergeTask(props.task.id, { squash: true, cleanup: true });
      showNotification('Merged to main');
    } catch (err) {
      showNotification(`Merge failed: ${err}`);
    }
    props.onClose();
  }

  async function handleRebase() {
    try {
      await invoke(IPC.RebaseTask, {
        worktreePath: props.task.worktreePath,
        baseBranch: props.task.baseBranch || 'main',
      });
      showNotification('Rebased onto main');
    } catch (err) {
      showNotification(`Rebase failed: ${err}`);
    }
    props.onClose();
  }

  function handleOpenInEditor() {
    invoke(IPC.ShellOpenInEditor, { path: props.task.worktreePath });
    props.onClose();
  }

  function handleClose() {
    closeTask(props.task.id);
    props.onClose();
  }

  const menuItemStyle = {
    padding: '6px 12px',
    cursor: 'pointer',
    'font-size': '12px',
    color: 'var(--fg)',
    'border-radius': '4px',
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: 'absolute',
        top: '100%',
        left: '0',
        'margin-top': '4px',
        background: 'var(--island-bg)',
        border: '1px solid var(--border)',
        'border-radius': '8px',
        padding: '4px',
        'min-width': '180px',
        'z-index': '1000',
        'box-shadow': 'var(--shadow-soft)',
      }}
    >
      <div style={menuItemStyle} onClick={handleCreatePR} onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
        Create PR
      </div>
      <div style={menuItemStyle} onClick={handleOpenPR} onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
        Open PR in Browser
      </div>
      <div style={menuItemStyle} onClick={handlePush} onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
        Push to Remote
      </div>
      <div style={menuItemStyle} onClick={handleMerge} onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
        Merge to Main
      </div>
      <div style={menuItemStyle} onClick={handleRebase} onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
        Rebase onto Main
      </div>
      <div style={menuItemStyle} onClick={handleOpenInEditor} onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
        Open in Editor
      </div>
      <div style={{ height: '1px', background: 'var(--border)', margin: '4px 0' }} />
      <div
        style={{ ...menuItemStyle, color: 'var(--error)' }}
        onClick={handleClose}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        Close Task
      </div>
    </div>
  );
}
```

**Step 2: Create HeaderTabBar**

Create `src/components/HeaderTabBar.tsx`:

```tsx
import { For, Show, createSignal } from 'solid-js';
import { store, setActiveTask, showNotification } from '../store/store';
import { createTask } from '../store/tasks';
import { getTaskDotStatus } from '../store/taskStatus';
import { StatusDot } from './StatusDot';
import { TabDropdownMenu } from './TabDropdownMenu';
import type { Task } from '../store/types';

export function HeaderTabBar() {
  const [creatingTask, setCreatingTask] = createSignal(false);
  const [promptText, setPromptText] = createSignal('');
  const [openDropdown, setOpenDropdown] = createSignal<string | null>(null);
  let inputRef: HTMLInputElement | undefined;

  const tasks = () => store.taskOrder.map((id) => store.tasks[id]).filter(Boolean);

  async function handleCreateTask() {
    const prompt = promptText().trim();
    if (!prompt) return;
    if (!store.lastProjectId) {
      showNotification('Link a project first');
      return;
    }

    const taskName = prompt.slice(0, 50);
    const claudeAgent = store.availableAgents.find((a) => a.id === 'claude-code') ?? store.availableAgents[0];
    if (!claudeAgent) {
      showNotification('Claude Code not found');
      return;
    }

    try {
      await createTask({
        name: taskName,
        agentDef: claudeAgent,
        projectId: store.lastProjectId,
        gitIsolation: 'worktree',
        baseBranch: 'main',
        initialPrompt: prompt,
        skipPermissions: true,
      });
    } catch (err) {
      showNotification(`Failed to create task: ${err}`);
    }

    setPromptText('');
    setCreatingTask(false);
  }

  function handleInputKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleCreateTask();
    }
    if (e.key === 'Escape') {
      setCreatingTask(false);
      setPromptText('');
    }
  }

  function startCreating() {
    setCreatingTask(true);
    setTimeout(() => inputRef?.focus(), 0);
  }

  const statusColor = (task: Task) => {
    const status = getTaskDotStatus(task.id);
    switch (status) {
      case 'busy': return 'var(--warning)';
      case 'waiting': return 'var(--fg-subtle)';
      case 'ready': return 'var(--success)';
      default: return 'var(--fg-subtle)';
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        height: '36px',
        'min-height': '36px',
        background: 'var(--bg-elevated)',
        'border-bottom': '1px solid var(--border-subtle)',
        padding: '0 8px',
        gap: '2px',
        'overflow-x': 'auto',
        'flex-shrink': '0',
      }}
    >
      <For each={tasks()}>
        {(task) => (
          <div style={{ position: 'relative', display: 'flex', 'align-items': 'center' }}>
            <button
              onClick={() => setActiveTask(task.id)}
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
                padding: '4px 10px',
                height: '28px',
                background: store.activeTaskId === task.id ? 'var(--bg-selected)' : 'transparent',
                border: 'none',
                'border-radius': '6px',
                color: store.activeTaskId === task.id ? 'var(--fg)' : 'var(--fg-muted)',
                'font-size': '12px',
                'font-family': 'var(--font-ui)',
                cursor: 'pointer',
                'white-space': 'nowrap',
                'max-width': '200px',
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
              }}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  'border-radius': '50%',
                  background: statusColor(task),
                  'flex-shrink': '0',
                }}
              />
              {task.name}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpenDropdown(openDropdown() === task.id ? null : task.id);
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--fg-muted)',
                cursor: 'pointer',
                padding: '2px 4px',
                'font-size': '10px',
                'border-radius': '4px',
              }}
            >
              ▾
            </button>
            <Show when={openDropdown() === task.id}>
              <TabDropdownMenu task={task} onClose={() => setOpenDropdown(null)} />
            </Show>
          </div>
        )}
      </For>

      <Show when={creatingTask()}>
        <input
          ref={inputRef}
          type="text"
          placeholder="Describe the task..."
          value={promptText()}
          onInput={(e) => setPromptText(e.currentTarget.value)}
          onKeyDown={handleInputKeyDown}
          onBlur={() => {
            if (!promptText().trim()) setCreatingTask(false);
          }}
          style={{
            height: '26px',
            'min-width': '200px',
            'max-width': '400px',
            flex: '1',
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            'border-radius': '6px',
            color: 'var(--fg)',
            'font-size': '12px',
            'font-family': 'var(--font-ui)',
            padding: '0 8px',
            outline: 'none',
          }}
        />
      </Show>

      <button
        onClick={startCreating}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          'border-radius': '6px',
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          padding: '4px 10px',
          height: '28px',
          'font-size': '12px',
          'font-family': 'var(--font-ui)',
          'flex-shrink': '0',
        }}
      >
        +
      </button>
    </div>
  );
}
```

**Step 3: Wire HeaderTabBar into App.tsx**

In `src/App.tsx`, import `HeaderTabBar` and insert it after the titlebar spacer (line 672) and before `<main>` (line 673):

```tsx
import { HeaderTabBar } from './components/HeaderTabBar';

// ... inside the render, after the mac-titlebar-spacer Show block (line 672):
<HeaderTabBar />
<main style={{ flex: '1', display: 'flex', overflow: 'hidden' }}>
```

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: May have errors around IPC.CreatePR / IPC.OpenPR (not yet added) — comment those lines for now.

**Step 5: Commit**

```bash
git add src/components/HeaderTabBar.tsx src/components/TabDropdownMenu.tsx src/App.tsx
git commit -m "feat: add header tab bar with per-task dropdown menus"
```

---

### Task 4: Add PR IPC Channels (Backend)

**Files:**
- Modify: `electron/ipc/channels.ts` (add CreatePR, OpenPR channels)
- Modify: `electron/ipc/register.ts` (add handlers)
- Modify: `electron/preload.cjs` (add to allowlist)

**Step 1: Add channels**

In `electron/ipc/channels.ts`, add to the enum before the closing brace:

```typescript
  // PR
  CreatePR = 'create_pr',
  OpenPR = 'open_pr',
```

**Step 2: Add handlers in register.ts**

In `electron/ipc/register.ts`, inside `registerAllHandlers`, add:

```typescript
  ipcMain.handle(IPC.CreatePR, async (_event, args: Record<string, unknown>) => {
    const worktreePath = assertString(args, 'worktreePath');
    assertAbsolutePath(worktreePath);
    const { stdout } = await execFile('gh', ['pr', 'create', '--fill'], { cwd: worktreePath });
    return stdout.trim();
  });

  ipcMain.handle(IPC.OpenPR, async (_event, args: Record<string, unknown>) => {
    const worktreePath = assertString(args, 'worktreePath');
    assertAbsolutePath(worktreePath);
    await execFile('gh', ['pr', 'view', '--web'], { cwd: worktreePath });
  });
```

Note: Use the existing `exec` or `execFile` helper that the file already uses. Check the import pattern.

**Step 3: Update preload allowlist**

In `electron/preload.cjs`, add `'create_pr'` and `'open_pr'` to the `ALLOWED_CHANNELS` array.

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add electron/ipc/channels.ts electron/ipc/register.ts electron/preload.cjs
git commit -m "feat: add CreatePR and OpenPR IPC channels for gh CLI integration"
```

---

### Task 5: Simplify Task Creation — Hardcode Defaults

**Files:**
- Modify: `src/store/tasks.ts:73-86` (simplify CreateTaskOptions)
- Modify: `src/components/HeaderTabBar.tsx` (ensure hardcoded defaults)
- Delete or gut: `src/components/NewTaskDialog.tsx`
- Modify: `src/App.tsx` (remove NewTaskDialog import and usage)

**Step 1: Remove NewTaskDialog from App.tsx**

In `src/App.tsx`, remove the import of `NewTaskDialog` (line 10) and the `<NewTaskDialog>` element (lines 708-711). Remove `toggleNewTaskDialog` from the store imports. Remove the Cmd+N shortcut handler that opens the dialog — rewire it to focus the `+` button in HeaderTabBar instead (or leave it for now).

**Step 2: Remove collapsed task logic**

In `src/store/types.ts`, remove `collapsed` and `savedAgentDef` from the `Task` interface (lines 56-57). Remove `collapsedTaskOrder` from `AppStore` (line 156). Remove `collapsed` and related fields from `PersistedTask` and `PersistedState`.

In `src/store/tasks.ts`, remove `collapseTask` and `uncollapseTask` functions if they exist.

**Step 3: Hardcode task defaults in createTask**

The `createTask` function in `src/store/tasks.ts` keeps working as-is — the hardcoding happens at the call site (HeaderTabBar). The function already accepts these as parameters. No changes needed to the function itself, but remove the `direct` mode branch (lines 122-129) since gitIsolation is always 'worktree'.

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: Errors about missing collapsed/collapsedTaskOrder references — fix all usages.

**Step 5: Commit**

```bash
git add src/App.tsx src/store/tasks.ts src/store/types.ts src/components/HeaderTabBar.tsx
git commit -m "feat: simplify task creation to prompt-only, remove NewTaskDialog and collapsed tasks"
```

---

### Task 6: Clean Up Sidebar — Remove Collapsed Tasks

**Files:**
- Modify: `src/components/Sidebar.tsx` (remove collapsed task rendering)
- Modify: `src/store/sidebar-order.ts` (remove collapsedTaskOrder references)

**Step 1: Remove collapsed task sections from Sidebar**

Find and remove any rendering of `store.collapsedTaskOrder` or collapsed task rows. The sidebar should only show active tasks from `store.taskOrder`.

Remove the "New Task" button from sidebar — task creation is now via the header tab bar `+` button.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/components/Sidebar.tsx src/store/sidebar-order.ts
git commit -m "feat: remove collapsed tasks and New Task button from sidebar"
```

---

### Task 7: Remove Settings Theme Picker

**Files:**
- Modify: `src/components/SettingsDialog.tsx` (remove theme preset selector, remove custom agents section)
- Modify: `src/store/ui.ts` (remove setThemePreset or simplify)

**Step 1: Remove theme picker from SettingsDialog**

In `src/components/SettingsDialog.tsx`, find the theme preset selector (likely renders `LOOK_PRESETS`) and remove that entire section. Also remove the custom agents section since agent is always Claude Code.

**Step 2: Remove unused store exports**

In `src/store/ui.ts`, remove `setThemePreset` if it only existed for the settings UI. Keep other settings (font, auto-trust, notifications, etc.).

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/SettingsDialog.tsx src/store/ui.ts
git commit -m "feat: remove theme picker and custom agents from settings"
```

---

### Task 8: Remove Unused Components

**Files:**
- Delete: `src/components/TaskBranchInfoBar.tsx`
- Delete: `src/components/TaskNotesPanel.tsx`
- Delete: `src/components/TaskShellSection.tsx`
- Delete: `src/components/PromptInput.tsx`
- Delete: `src/components/CloseTaskDialog.tsx`
- Delete: `src/components/NewTaskDialog.tsx`
- Delete: `src/components/DiffViewerDialog.tsx` (if not used elsewhere)
- Delete: `src/components/PlanViewerDialog.tsx`

**Step 1: Delete files**

Delete each file listed above. If any are still imported elsewhere (check with grep), remove those imports first.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (if any remaining references, fix them)

**Step 3: Run lint**

Run: `npm run check`
Expected: PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove unused components (notes, prompt, branch info, shell tabs, dialogs)"
```

---

### Task 9: Worktree Symlink Reliability

**Files:**
- Modify: `electron/ipc/git.ts:404-486` (improve symlink error handling)

**Step 1: Audit and fix symlink creation**

In `electron/ipc/git.ts`, improve the `createWorktree` function (line 429) and `shallowSymlinkDir` (line 404):

1. Before creating symlink, check if source is a directory vs file and handle accordingly
2. If target already exists as a broken symlink, remove it before re-creating
3. Add `forceClean = true` as default (currently `false`) so stale worktrees are always cleaned
4. In `shallowSymlinkDir`, handle the case where the target entry already exists as a broken symlink:

```typescript
// In shallowSymlinkDir, before creating symlink:
if (fs.existsSync(dst) || fs.lstatSync(dst).isSymbolicLink()) {
  // Remove stale/broken symlink
  fs.unlinkSync(dst);
}
fs.symlinkSync(src, dst);
```

Wait — `fs.existsSync` returns false for broken symlinks. Use `fs.lstatSync` wrapped in try/catch to detect broken symlinks:

```typescript
try {
  fs.lstatSync(dst);
  // Entry exists (possibly broken symlink) — skip or remove
  try {
    fs.readlinkSync(dst); // If this works, it's a symlink
    const resolved = fs.realpathSync(dst);
    // Valid symlink pointing somewhere — skip
  } catch {
    // Broken symlink — remove and recreate
    fs.unlinkSync(dst);
    fs.symlinkSync(src, dst);
  }
} catch {
  // Doesn't exist at all — create
  fs.symlinkSync(src, dst);
}
```

5. After worktree creation, verify all expected symlinks exist and log any that are missing.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add electron/ipc/git.ts
git commit -m "fix: improve worktree symlink reliability (handle stale/broken symlinks)"
```

---

### Task 10: Final Integration — TilingLayout Cleanup

**Files:**
- Modify: `src/components/TilingLayout.tsx` (remove empty state for collapsed tasks, simplify placeholder)

**Step 1: Remove collapsed task empty state**

In `src/components/TilingLayout.tsx`, remove the "All tasks are collapsed" empty state (lines 199-214). The remaining empty states ("Link your first project" and "No tasks yet") stay.

**Step 2: Remove NewTaskPlaceholder references**

The placeholder panel that shows "+" in the tiling layout can be simplified or removed since task creation is now in the header tab bar.

**Step 3: Full build check**

Run: `npm run check`
Expected: PASS (typecheck + lint + format)

**Step 4: Manual test**

Run: `npm run dev`
Verify:
- Single dark theme applied everywhere
- Header tab bar shows with `+` button
- Clicking `+` shows inline prompt input
- Typing prompt + Enter creates a task with Claude Code in worktree
- Terminal fills the full panel (no notes, prompt input, etc.)
- Tab dropdown shows all actions (Create PR, Push, Merge, etc.)
- Sidebar still shows projects and tasks
- Clicking sidebar task focuses it

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: complete Warp-style UI redesign — terminal-first with header tabs"
```

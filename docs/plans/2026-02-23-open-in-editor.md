# Open in Default Editor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an "Open in editor" button to the diff viewer dialog that opens the file using the OS default application via Electron's `shell.openPath()`.

**Architecture:** New IPC channel `ShellOpenFile` → backend handler joins worktree path + relative file path, validates both, calls `shell.openPath()`. Frontend adds a button to the `DiffViewerDialog` header and a wrapper in `shell.ts`.

**Tech Stack:** Electron `shell.openPath()`, SolidJS, TypeScript

---

### Task 1: Add IPC Channel

**Files:**

- Modify: `electron/ipc/channels.ts:59` (Shell section)

**Step 1: Add the channel enum value**

In the `// Shell` section, add after `ShellReveal`:

```typescript
  // Shell
  ShellReveal = '__shell_reveal',
  ShellOpenFile = '__shell_open_file',
```

**Step 2: Commit**

```bash
git add electron/ipc/channels.ts
git commit -m "feat(ipc): add ShellOpenFile channel"
```

---

### Task 2: Add Backend Handler

**Files:**

- Modify: `electron/ipc/register.ts:209-212` (Shell/Opener section)

**Step 1: Add the handler**

After the `ShellReveal` handler (line 212), add:

```typescript
ipcMain.handle(IPC.ShellOpenFile, (_e, args) => {
  validatePath(args.worktreePath, 'worktreePath');
  validateRelativePath(args.filePath, 'filePath');
  return shell.openPath(path.join(args.worktreePath, args.filePath));
});
```

This reuses the existing `validatePath` and `validateRelativePath` helpers. `shell.openPath()` returns a `Promise<string>` — empty string on success, error message on failure.

**Step 2: Commit**

```bash
git add electron/ipc/register.ts
git commit -m "feat(ipc): handle ShellOpenFile with shell.openPath"
```

---

### Task 3: Add Frontend Wrapper

**Files:**

- Modify: `src/lib/shell.ts`

**Step 1: Add the wrapper function**

Append to `shell.ts`:

```typescript
export async function openFileInEditor(worktreePath: string, filePath: string): Promise<void> {
  const errorMessage = (await window.electron.ipcRenderer.invoke(IPC.ShellOpenFile, {
    worktreePath,
    filePath,
  })) as string;
  if (errorMessage) throw new Error(errorMessage);
}
```

**Step 2: Commit**

```bash
git add src/lib/shell.ts
git commit -m "feat(shell): add openFileInEditor wrapper"
```

---

### Task 4: Add Button to Diff Viewer Dialog

**Files:**

- Modify: `src/components/DiffViewerDialog.tsx`

**Step 1: Import the wrapper**

Add to existing imports:

```typescript
import { openFileInEditor } from '../lib/shell';
```

**Step 2: Add the button**

In the header `<div>`, between the Split/Unified toggle `</div>` (line 197) and the close `<button>` (line 199), add:

```tsx
<button
  onClick={() => openFileInEditor(props.worktreePath, file().path)}
  style={{
    background: 'transparent',
    border: 'none',
    color: theme.fgMuted,
    cursor: 'pointer',
    padding: '4px',
    display: 'flex',
    'align-items': 'center',
    'border-radius': '4px',
  }}
  title="Open in editor"
>
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M1.5 1.75V6h.75a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75V1.75A1.75 1.75 0 0 1 1.75 0h4.5a.75.75 0 0 1 0 1.5h-4.5a.25.25 0 0 0-.25.25ZM8.75 0a.75.75 0 0 1 .75.75V2h3.25a.75.75 0 0 1 0 1.5H9.5v1.25a.75.75 0 0 1-1.5 0v-4A.75.75 0 0 1 8.75 0ZM0 9.5a.75.75 0 0 1 .75-.75h.75v-1a.75.75 0 0 1 1.5 0v1.75a.75.75 0 0 1-.75.75H.75A.75.75 0 0 1 0 9.5ZM5 14.25a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z" />
  </svg>
</button>
```

Wait — let me use a cleaner "external-link" / "open" icon instead. A simple square-with-arrow icon:

```tsx
<button
  onClick={() => openFileInEditor(props.worktreePath, file().path)}
  style={{
    background: 'transparent',
    border: 'none',
    color: theme.fgMuted,
    cursor: 'pointer',
    padding: '4px',
    display: 'flex',
    'align-items': 'center',
    'border-radius': '4px',
  }}
  title="Open in editor"
>
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3a.75.75 0 0 1 1.5 0v3A3 3 0 0 1 12.5 16h-9A3 3 0 0 1 0 12.5v-9A3 3 0 0 1 3.5 0h3a.75.75 0 0 1 0 1.5h-3ZM10 .75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V2.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L13.44 1.5H10.75A.75.75 0 0 1 10 .75Z" />
  </svg>
</button>
```

**Step 3: Commit**

```bash
git add src/components/DiffViewerDialog.tsx
git commit -m "feat(diff): add open-in-editor button to diff viewer header"
```

---

### Task 5: Typecheck

**Step 1: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 2: Manual test**

```bash
npm run dev
```

Open a task → click a changed file → verify the "Open in editor" button appears and opens the file.

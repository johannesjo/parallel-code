import { createSignal, createEffect, For, Show } from 'solid-js';
import { Dialog } from './Dialog';
import {
  updateProject,
  PASTEL_HUES,
  isProjectMissing,
  relinkProject,
  removeProjectWithTasks,
} from '../store/store';
import { sanitizeBranchPrefix, toBranchName } from '../lib/branch-name';
import { theme } from '../lib/theme';
import { CommandListEditor, type CommandVariable } from './CommandListEditor';
import { PathSelector } from './PathSelector';
import type { Project } from '../store/types';

interface EditProjectDialogProps {
  project: Project | null;
  onClose: () => void;
}

function hueFromColor(color: string): number {
  const match = color.match(/hsl\((\d+)/);
  return match ? Number(match[1]) : 0;
}

export function EditProjectDialog(props: EditProjectDialogProps) {
  const [name, setName] = createSignal('');
  const [selectedHue, setSelectedHue] = createSignal(0);
  const [branchPrefix, setBranchPrefix] = createSignal('task');
  const [deleteBranchOnClose, setDeleteBranchOnClose] = createSignal(true);
  const [defaultDirectMode, setDefaultDirectMode] = createSignal(false);
  const [bookmarks, setBookmarks] = createSignal<string[]>([]);
  const [setupCommands, setSetupCommands] = createSignal<string[]>([]);
  const [teardownCommands, setTeardownCommands] = createSignal<string[]>([]);
  const [symlinkDirs, setSymlinkDirs] = createSignal<string[]>([]);
  let nameRef!: HTMLInputElement;

  // Sync signals when project prop changes
  createEffect(() => {
    const p = props.project;
    if (!p) return;
    setName(p.name);
    setSelectedHue(hueFromColor(p.color));
    setBranchPrefix(sanitizeBranchPrefix(p.branchPrefix ?? 'task'));
    setDeleteBranchOnClose(p.deleteBranchOnClose ?? true);
    setDefaultDirectMode(p.defaultDirectMode ?? false);
    setBookmarks(p.terminalBookmarks ? p.terminalBookmarks.map((b) => b.command) : []);
    setSetupCommands(p.setupCommands ? [...p.setupCommands] : []);
    setTeardownCommands(p.teardownCommands ? [...p.teardownCommands] : []);
    setSymlinkDirs(p.defaultSymlinkDirs ? [...p.defaultSymlinkDirs] : []);
    requestAnimationFrame(() => nameRef?.focus());
  });

  const commandVariables = (projectPath: string): CommandVariable[] => [
    {
      name: 'PROJECT_ROOT',
      description: 'Root repository path',
      example: projectPath,
    },
    {
      name: 'WORKTREE',
      description: 'Current task worktree path',
      example: `${projectPath}/.worktrees/task/my-task`,
    },
  ];

  const canSave = () => name().trim().length > 0;

  function handleSave() {
    if (!canSave() || !props.project) return;
    const sanitizedPrefix = sanitizeBranchPrefix(branchPrefix());
    updateProject(props.project.id, {
      name: name().trim(),
      color: `hsl(${selectedHue()}, 70%, 75%)`,
      branchPrefix: sanitizedPrefix,
      deleteBranchOnClose: deleteBranchOnClose(),
      defaultDirectMode: defaultDirectMode(),
      terminalBookmarks: bookmarks().map((cmd) => ({ id: crypto.randomUUID(), command: cmd })),
      setupCommands: setupCommands().length > 0 ? setupCommands() : undefined,
      teardownCommands: teardownCommands().length > 0 ? teardownCommands() : undefined,
      defaultSymlinkDirs: symlinkDirs().length > 0 ? [...symlinkDirs()] : undefined,
    });
    props.onClose();
  }

  return (
    <Dialog
      open={props.project !== null}
      onClose={props.onClose}
      width="480px"
      panelStyle={{ gap: '20px' }}
    >
      <Show when={props.project}>
        {(project) => (
          <>
            <h2
              style={{
                margin: '0',
                'font-size': '16px',
                color: theme.fg,
                'font-weight': '600',
              }}
            >
              Edit Project
            </h2>

            {/* Path */}
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
              }}
            >
              <div
                style={{
                  'font-size': '12px',
                  color: theme.fgSubtle,
                  'font-family': "'JetBrains Mono', monospace",
                  flex: '1',
                  'min-width': '0',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                }}
              >
                {project().path}
              </div>
              <button
                type="button"
                onClick={() => relinkProject(project().id)}
                style={{
                  padding: '3px 10px',
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '6px',
                  color: theme.fgMuted,
                  cursor: 'pointer',
                  'font-size': '11px',
                  'flex-shrink': '0',
                }}
              >
                Change
              </button>
            </div>

            <Show when={isProjectMissing(project().id)}>
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '10px',
                  padding: '10px 14px',
                  'border-radius': '8px',
                  background: `color-mix(in srgb, ${theme.warning} 10%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${theme.warning} 30%, transparent)`,
                  color: theme.warning,
                  'font-size': '12px',
                }}
              >
                <span style={{ flex: '1' }}>This folder no longer exists.</span>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await relinkProject(project().id);
                    if (ok) props.onClose();
                  }}
                  style={{
                    padding: '5px 12px',
                    background: theme.bgInput,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                    color: theme.fg,
                    cursor: 'pointer',
                    'font-size': '12px',
                    'flex-shrink': '0',
                  }}
                >
                  Re-link
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await removeProjectWithTasks(project().id);
                    props.onClose();
                  }}
                  style={{
                    padding: '5px 12px',
                    background: 'transparent',
                    border: `1px solid color-mix(in srgb, ${theme.error} 40%, transparent)`,
                    'border-radius': '6px',
                    color: theme.error,
                    cursor: 'pointer',
                    'font-size': '12px',
                    'flex-shrink': '0',
                  }}
                >
                  Remove
                </button>
              </div>
            </Show>

            {/* Name */}
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
              <label
                style={{
                  'font-size': '11px',
                  color: theme.fgMuted,
                  'text-transform': 'uppercase',
                  'letter-spacing': '0.05em',
                }}
              >
                Name
              </label>
              <input
                ref={nameRef}
                class="input-field"
                type="text"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSave()) handleSave();
                }}
                style={{
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '8px',
                  padding: '10px 14px',
                  color: theme.fg,
                  'font-size': '13px',
                  outline: 'none',
                }}
              />
            </div>

            {/* Branch prefix */}
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
              <label
                style={{
                  'font-size': '11px',
                  color: theme.fgMuted,
                  'text-transform': 'uppercase',
                  'letter-spacing': '0.05em',
                }}
              >
                Branch prefix
              </label>
              <input
                class="input-field"
                type="text"
                value={branchPrefix()}
                onInput={(e) => setBranchPrefix(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSave()) handleSave();
                }}
                placeholder="task"
                style={{
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '8px',
                  padding: '10px 14px',
                  color: theme.fg,
                  'font-size': '13px',
                  'font-family': "'JetBrains Mono', monospace",
                  outline: 'none',
                }}
              />
              <Show when={branchPrefix().trim()}>
                <div
                  style={{
                    'font-size': '11px',
                    'font-family': "'JetBrains Mono', monospace",
                    color: theme.fgSubtle,
                    padding: '2px 2px 0',
                    display: 'flex',
                    'align-items': 'center',
                    gap: '6px',
                  }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    style={{ 'flex-shrink': '0' }}
                  >
                    <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
                  </svg>
                  {sanitizeBranchPrefix(branchPrefix())}/{toBranchName('example-branch-name')}
                </div>
              </Show>
            </div>

            {/* Color palette */}
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
              <label
                style={{
                  'font-size': '11px',
                  color: theme.fgMuted,
                  'text-transform': 'uppercase',
                  'letter-spacing': '0.05em',
                }}
              >
                Color
              </label>
              <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
                <For each={PASTEL_HUES}>
                  {(hue) => {
                    const color = `hsl(${hue}, 70%, 75%)`;
                    const isSelected = () => selectedHue() === hue;
                    return (
                      <button
                        type="button"
                        onClick={() => setSelectedHue(hue)}
                        style={{
                          width: '28px',
                          height: '28px',
                          'border-radius': '50%',
                          background: color,
                          border: isSelected() ? `2px solid ${theme.fg}` : '2px solid transparent',
                          outline: isSelected() ? `2px solid ${theme.accent}` : 'none',
                          'outline-offset': '1px',
                          cursor: 'pointer',
                          padding: '0',
                          'flex-shrink': '0',
                        }}
                        title={`Hue ${hue}`}
                      />
                    );
                  }}
                </For>
              </div>
            </div>

            {/* Merge cleanup preference */}
            <label
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                cursor: 'pointer',
                'font-size': '13px',
                color: theme.fg,
              }}
            >
              <input
                type="checkbox"
                checked={deleteBranchOnClose()}
                onChange={(e) => setDeleteBranchOnClose(e.currentTarget.checked)}
                style={{ cursor: 'pointer' }}
              />
              Always delete branch and worklog on merge
            </label>

            {/* Default direct mode preference */}
            <label
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
                cursor: 'pointer',
                'font-size': '13px',
                color: theme.fg,
              }}
            >
              <input
                type="checkbox"
                checked={defaultDirectMode()}
                onChange={(e) => setDefaultDirectMode(e.currentTarget.checked)}
                style={{ cursor: 'pointer' }}
              />
              Default to working directly on main branch
            </label>

            {/* Command Bookmarks */}
            <CommandListEditor
              label="Command Bookmarks"
              placeholder="e.g. npm run dev"
              items={bookmarks()}
              onAdd={(cmd) => setBookmarks([...bookmarks(), cmd])}
              onRemove={(i) => setBookmarks(bookmarks().filter((_, idx) => idx !== i))}
            />

            {/* Setup Commands */}
            <CommandListEditor
              label="Setup Commands"
              description="Run in each new worktree before the agent starts"
              placeholder="e.g. npm install"
              items={setupCommands()}
              onAdd={(cmd) => setSetupCommands([...setupCommands(), cmd])}
              onRemove={(i) => setSetupCommands(setupCommands().filter((_, idx) => idx !== i))}
              variables={commandVariables(project().path)}
            />

            {/* Teardown Commands */}
            <CommandListEditor
              label="Teardown Commands"
              description="Run in worktree before it is removed on task close"
              placeholder="e.g. npm run cleanup"
              items={teardownCommands()}
              onAdd={(cmd) => setTeardownCommands([...teardownCommands(), cmd])}
              onRemove={(i) =>
                setTeardownCommands(teardownCommands().filter((_, idx) => idx !== i))
              }
              variables={commandVariables(project().path)}
            />

            {/* Default Symlink Dirs */}
            <PathSelector
              dirs={symlinkDirs()}
              projectRoot={project().path}
              onAdd={(dir) => setSymlinkDirs([...symlinkDirs(), dir])}
              onRemove={(i) => setSymlinkDirs(symlinkDirs().filter((_, idx) => idx !== i))}
            />

            {/* Buttons */}
            <div
              style={{
                display: 'flex',
                gap: '8px',
                'justify-content': 'flex-end',
                'padding-top': '4px',
              }}
            >
              <button
                type="button"
                class="btn-secondary"
                onClick={() => props.onClose()}
                style={{
                  padding: '9px 18px',
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '8px',
                  color: theme.fgMuted,
                  cursor: 'pointer',
                  'font-size': '13px',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn-primary"
                disabled={!canSave()}
                onClick={handleSave}
                style={{
                  padding: '9px 20px',
                  background: theme.accent,
                  border: 'none',
                  'border-radius': '8px',
                  color: theme.accentText,
                  cursor: canSave() ? 'pointer' : 'not-allowed',
                  'font-size': '13px',
                  'font-weight': '500',
                  opacity: canSave() ? '1' : '0.4',
                }}
              >
                Save
              </button>
            </div>
          </>
        )}
      </Show>
    </Dialog>
  );
}

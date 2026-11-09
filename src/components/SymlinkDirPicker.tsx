import { For, Show } from 'solid-js';
import { theme } from '../lib/theme';

interface SymlinkDirPickerProps {
  dirs: string[];
  selectedDirs: ReadonlySet<string>;
  /** Entries the project's saved include list copies instead of symlinking. */
  copyDirs?: ReadonlySet<string>;
  onToggle: (dir: string) => void;
}

export function SymlinkDirPicker(props: SymlinkDirPickerProps) {
  return (
    <div
      data-nav-field="symlink-dirs"
      style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
    >
      <label
        style={{
          'font-size': '12px',
          color: theme.fgMuted,
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
        }}
      >
        {props.copyDirs && props.copyDirs.size > 0
          ? 'Bring into worktree'
          : 'Symlink into worktree'}
      </label>
      <span style={{ 'font-size': '12px', color: theme.fgMuted }}>
        Checked entries are written to .git/info/exclude and apply to all worktrees.
      </span>
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '4px',
          padding: '8px 10px',
          background: theme.bgElevated,
          'border-radius': 'var(--radius-sm)',
          border: `1px solid ${theme.border}`,
          'max-height': '160px',
          'overflow-y': 'auto',
        }}
      >
        <For each={props.dirs}>
          {(dir) => {
            const checked = () => props.selectedDirs.has(dir);
            return (
              <label
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '8px',
                  'font-size': '13px',
                  'font-family': "'JetBrains Mono', monospace",
                  color: theme.fg,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked()}
                  onChange={() => props.onToggle(dir)}
                  style={{ 'accent-color': theme.accent }}
                />
                {dir}
                {/* Set in project settings; a label, not a per-task control. */}
                <Show when={props.copyDirs?.has(dir)}>
                  <span style={{ 'font-size': '11px', color: theme.fgSubtle }}>copy</span>
                </Show>
              </label>
            );
          }}
        </For>
      </div>
    </div>
  );
}

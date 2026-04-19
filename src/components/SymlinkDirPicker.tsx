import { For } from 'solid-js';
import { theme } from '../lib/theme';

interface SymlinkDirPickerProps {
  dirs: string[];
  selectedDirs: Set<string>;
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
        Symlink into worktree
      </label>
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '4px',
          padding: '8px 10px',
          background: theme.bgElevated,
          'border-radius': '6px',
          border: `1px solid ${theme.border}`,
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
              </label>
            );
          }}
        </For>
      </div>
    </div>
  );
}

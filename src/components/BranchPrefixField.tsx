import { Show } from 'solid-js';
import { theme } from '../lib/theme';
import { FolderIcon, GitBranchIcon } from './icons';

interface BranchPrefixFieldProps {
  branchPrefix: string;
  branchPreview: string;
  error?: string;
  projectPath: string | undefined;
  onPrefixChange: (prefix: string) => void;
}

export function BranchPrefixField(props: BranchPrefixFieldProps) {
  return (
    <div
      data-nav-field="branch-prefix"
      style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
        <label style={{ 'font-size': '12px', color: theme.fgSubtle, 'white-space': 'nowrap' }}>
          Branch prefix
        </label>
        <input
          class="input-field"
          type="text"
          value={props.branchPrefix}
          onInput={(e) => props.onPrefixChange(e.currentTarget.value)}
          placeholder="task"
          style={{
            background: theme.bgInput,
            border: `1px solid ${props.error ? theme.error : theme.border}`,
            'border-radius': 'var(--radius-sm)',
            padding: '4px 8px',
            color: theme.fg,
            'font-size': '13px',
            'font-family': "'JetBrains Mono', monospace",
            outline: 'none',
            width: '120px',
          }}
        />
      </div>
      <Show when={props.error}>
        <div style={{ 'font-size': '12px', color: theme.error }}>{props.error}</div>
      </Show>
      <Show when={props.branchPreview && props.projectPath}>
        <div
          style={{
            'font-size': '12px',
            'font-family': "'JetBrains Mono', monospace",
            color: theme.fgSubtle,
            display: 'flex',
            'flex-direction': 'column',
            gap: '2px',
            padding: '4px 2px 0',
          }}
        >
          <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
            <GitBranchIcon size={11} style={{ 'flex-shrink': '0' }} />
            {props.branchPreview}
          </span>
          <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
            <FolderIcon size={11} style={{ 'flex-shrink': '0' }} />
            {props.projectPath}/.worktrees/{props.branchPreview}
          </span>
        </div>
      </Show>
    </div>
  );
}

import { Show } from 'solid-js';
import { theme } from '../lib/theme';

interface BranchPrefixFieldProps {
  branchPrefix: string;
  branchPreview: string;
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
            border: `1px solid ${theme.border}`,
            'border-radius': '6px',
            padding: '4px 8px',
            color: theme.fg,
            'font-size': '13px',
            'font-family': "'JetBrains Mono', monospace",
            outline: 'none',
            width: '120px',
          }}
        />
      </div>
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
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="currentColor"
              style={{ 'flex-shrink': '0' }}
            >
              <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
            </svg>
            {props.branchPreview}
          </span>
          <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="currentColor"
              style={{ 'flex-shrink': '0' }}
            >
              <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
            </svg>
            {props.projectPath}/.worktrees/{props.branchPreview}
          </span>
        </div>
      </Show>
    </div>
  );
}

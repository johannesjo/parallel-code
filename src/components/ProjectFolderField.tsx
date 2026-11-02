import { Show } from 'solid-js';
import { isProjectMissing, relinkProject } from '../store/store';
import { sectionLabelStyle, theme } from '../lib/theme';
import { FolderIcon, LinkIcon, TrashIcon } from './icons';
import { projectButtonStyle } from './ProjectDialogParts';

interface ProjectFolderFieldProps {
  projectId: string;
  path: string;
  /** Called after Re-link from the missing-folder warning succeeds. */
  onRelinked: () => void;
  onRemove: () => void;
}

/** The project's folder, a way to point it elsewhere, and a warning when it is gone. */
export function ProjectFolderField(props: ProjectFolderFieldProps) {
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
      <span style={sectionLabelStyle}>Folder</span>
      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
        <span
          title={props.path}
          style={{
            flex: '1',
            'min-width': '0',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
            'font-size': '13px',
            'font-family': "'JetBrains Mono', monospace",
            color: theme.fgSubtle,
          }}
        >
          {props.path}
        </span>
        <button
          class="btn-with-icon"
          type="button"
          onClick={() => relinkProject(props.projectId)}
          style={projectButtonStyle}
        >
          <FolderIcon size={12} />
          Change…
        </button>
      </div>

      <Show when={isProjectMissing(props.projectId)}>
        <div
          role="alert"
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '8px',
            padding: '8px 12px',
            'border-radius': 'var(--radius-md)',
            background: `color-mix(in srgb, ${theme.warning} 10%, transparent)`,
            border: `1px solid color-mix(in srgb, ${theme.warning} 30%, transparent)`,
            color: theme.warning,
            'font-size': '13px',
          }}
        >
          <span style={{ flex: '1' }}>This folder no longer exists.</span>
          <button
            class="btn-with-icon"
            type="button"
            onClick={async () => {
              if (await relinkProject(props.projectId)) props.onRelinked();
            }}
            style={{ ...projectButtonStyle, color: theme.fg }}
          >
            <LinkIcon size={12} />
            Re-link
          </button>
          <button
            class="btn-with-icon"
            type="button"
            onClick={() => props.onRemove()}
            style={{
              ...projectButtonStyle,
              background: 'transparent',
              border: `1px solid color-mix(in srgb, ${theme.error} 40%, transparent)`,
              color: theme.error,
            }}
          >
            <TrashIcon size={12} />
            Remove
          </button>
        </div>
      </Show>
    </div>
  );
}

import { createSignal, For } from 'solid-js';
import type { TerminalBookmark } from '../store/types';
import { theme } from '../lib/theme';
import { CloseIcon, PlusIcon } from './icons';
import { ProjectField, projectButtonStyle, projectMonoInputStyle } from './ProjectDialogParts';

interface ProjectBookmarksFieldProps {
  bookmarks: TerminalBookmark[];
  onChange: (bookmarks: TerminalBookmark[]) => void;
}

/** Saved terminal commands: a removable list and an input to add one. */
export function ProjectBookmarksField(props: ProjectBookmarksFieldProps) {
  const [draft, setDraft] = createSignal('');

  function add() {
    const command = draft().trim();
    if (!command) return;
    props.onChange([...props.bookmarks, { id: crypto.randomUUID(), command }]);
    setDraft('');
  }

  return (
    <ProjectField
      label="Command bookmarks"
      hint="Appear as buttons in each task's shell section; a click runs the command there."
    >
      {(id) => (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
          <For each={props.bookmarks}>
            {(bookmark) => (
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '8px',
                  padding: '4px 4px 4px 12px',
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': 'var(--radius-sm)',
                }}
              >
                <span
                  title={bookmark.command}
                  style={{
                    flex: '1',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                    'font-size': '12px',
                    'font-family': "'JetBrains Mono', monospace",
                    color: theme.fgMuted,
                  }}
                >
                  {bookmark.command}
                </span>
                <button
                  type="button"
                  class="icon-btn"
                  aria-label={`Remove bookmark ${bookmark.command}`}
                  title="Remove bookmark"
                  onClick={() =>
                    props.onChange(props.bookmarks.filter((b) => b.id !== bookmark.id))
                  }
                  style={{
                    display: 'inline-flex',
                    background: 'transparent',
                    border: 'none',
                    color: theme.fgSubtle,
                    cursor: 'pointer',
                    padding: '4px',
                  }}
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            )}
          </For>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              id={id}
              class="input-field"
              type="text"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                add();
              }}
              placeholder="e.g. npm run dev"
              style={{ ...projectMonoInputStyle, flex: '1', 'min-width': '0' }}
            />
            <button
              class="btn-with-icon btn-secondary"
              type="button"
              onClick={add}
              disabled={!draft().trim()}
              style={{
                ...projectButtonStyle,
                'border-radius': 'var(--radius-md)',
                cursor: draft().trim() ? 'pointer' : 'not-allowed',
                opacity: draft().trim() ? '1' : '0.5',
              }}
            >
              <PlusIcon size={14} />
              Add
            </button>
          </div>
        </div>
      )}
    </ProjectField>
  );
}

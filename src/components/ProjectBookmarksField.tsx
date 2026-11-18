import { createSignal, For } from 'solid-js';
import type { TerminalBookmark } from '../store/types';
import { theme } from '../lib/theme';
import { BOOKMARK_NAME_MAX_LENGTH, bookmarkLabel, draftBookmark } from '../lib/bookmarks';
import { CloseIcon, PlusIcon } from './icons';
import { ProjectField, projectButtonStyle, projectMonoInputStyle } from './ProjectDialogParts';

interface ProjectBookmarksFieldProps {
  bookmarks: TerminalBookmark[];
  onChange: (bookmarks: TerminalBookmark[]) => void;
}

const rowTextStyle = {
  overflow: 'hidden',
  'text-overflow': 'ellipsis',
  'white-space': 'nowrap',
  'font-size': '12px',
} as const;

/** Saved project commands: a removable list and inputs to add one. */
export function ProjectBookmarksField(props: ProjectBookmarksFieldProps) {
  const [command, setCommand] = createSignal('');
  const [name, setName] = createSignal('');
  const [url, setUrl] = createSignal('');
  const canAdd = () => !!command().trim();

  function add() {
    const bookmark = draftBookmark({ command: command(), name: name(), url: url() });
    if (!bookmark) return;
    props.onChange([...props.bookmarks, bookmark]);
    setCommand('');
    setName('');
    setUrl('');
  }

  const onEnter = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    add();
  };

  return (
    <ProjectField
      label="Command bookmarks"
      hint={
        <>
          Buttons in each task's shell toolbar that run, stop and restart the command in its own
          terminal. Every task gets its own block of 10 ports, the first in $PARALLEL_CODE_PORT: use
          it to run servers side by side, e.g.{' '}
          <code>npm run dev -- --port $PARALLEL_CODE_PORT</code> with the link{' '}
          <code>localhost:$PARALLEL_CODE_PORT</code>, which opens in the task's browser preview. In
          cmd.exe write %PARALLEL_CODE_PORT%.
        </>
      }
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
                <span style={{ ...rowTextStyle, 'flex-shrink': '0', 'max-width': '30%' }}>
                  {bookmarkLabel(bookmark)}
                </span>
                <span
                  title={bookmark.url ? `${bookmark.command}\n${bookmark.url}` : bookmark.command}
                  style={{
                    ...rowTextStyle,
                    flex: '1',
                    'font-family': "'JetBrains Mono', monospace",
                    color: theme.fgMuted,
                  }}
                >
                  {bookmark.command}
                  {bookmark.url ? ` → ${bookmark.url}` : ''}
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
              aria-label="Command"
              value={command()}
              onInput={(e) => setCommand(e.currentTarget.value)}
              onKeyDown={onEnter}
              placeholder="e.g. npm run dev -- --port $PARALLEL_CODE_PORT"
              style={{ ...projectMonoInputStyle, flex: '1', 'min-width': '0' }}
            />
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              class="input-field"
              type="text"
              aria-label="Name (optional)"
              maxLength={BOOKMARK_NAME_MAX_LENGTH}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={onEnter}
              placeholder="Name (optional)"
              style={{ ...projectMonoInputStyle, width: '140px', 'flex-shrink': '0' }}
            />
            <input
              class="input-field"
              type="text"
              aria-label="Link (optional)"
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
              onKeyDown={onEnter}
              placeholder="Link (optional), e.g. localhost:$PARALLEL_CODE_PORT"
              style={{ ...projectMonoInputStyle, flex: '1', 'min-width': '0' }}
            />
            <button
              class="btn-with-icon btn-secondary"
              type="button"
              onClick={add}
              disabled={!canAdd()}
              style={{
                ...projectButtonStyle,
                'border-radius': 'var(--radius-md)',
                cursor: canAdd() ? 'pointer' : 'not-allowed',
                opacity: canAdd() ? '1' : '0.5',
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

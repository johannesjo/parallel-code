import { Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { store } from '../store/core';
import { setArchivedChildrenShown } from '../store/store';
import { ChevronDownAltIcon } from './icons';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

/**
 * Folds a coordinator's archived children behind one quiet sidebar row, so tasks
 * the coordinator gave up stay restorable without crowding the live ones.
 */
export function ArchivedChildrenGroup(props: {
  coordinatorId: string;
  count: number;
  children: JSX.Element;
}) {
  const shown = () => store.tasks[props.coordinatorId]?.archivedChildrenShown === true;
  const listId = () => `sidebar-archived-${props.coordinatorId}`;
  return (
    <Show when={props.count > 0}>
      <button
        type="button"
        class="projects-toggle"
        aria-expanded={shown()}
        aria-controls={listId()}
        title={shown() ? 'Hide archived subtasks' : 'Show archived subtasks'}
        onClick={() => setArchivedChildrenShown(props.coordinatorId, !shown())}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: theme.fgSubtle,
          cursor: 'pointer',
          'font-size': sf(11),
          'font-family': 'inherit',
          // Lines the label up with the child names below the coordinator.
          padding: '2px 2px 2px 26px',
          display: 'flex',
          'align-items': 'center',
          gap: '5px',
        }}
      >
        <ChevronDownAltIcon
          size={10}
          style={{
            'flex-shrink': '0',
            transform: shown() ? 'none' : 'rotate(-90deg)',
            transition: 'transform var(--motion-fast) var(--ease-out)',
          }}
        />
        {props.count} archived
      </button>
      {/* Rows sit in this wrapper, so it repeats the sidebar list's row gap. */}
      <div id={listId()} style={{ display: 'flex', 'flex-direction': 'column', gap: '3px' }}>
        <Show when={shown()}>{props.children}</Show>
      </div>
    </Show>
  );
}

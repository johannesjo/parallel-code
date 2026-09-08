import { onMount, onCleanup, type JSX } from 'solid-js';
import { toggleNewTaskDialog, createTerminal, unfocusPlaceholder } from '../store/store';
import { registerFocusFn, unregisterFocusFn } from '../store/focus';
import { theme } from '../lib/theme';
import { mod } from '../lib/platform';

/** Quiet ghost surface: a faint fill instead of a dashed wireframe border, so
 *  the add column reads as part of the strip rather than a placeholder. The
 *  hover/focus treatment lives in `.new-task-placeholder`. */
const ghostStyle: JSX.CSSProperties = {
  display: 'flex',
  'align-items': 'center',
  'justify-content': 'center',
  cursor: 'pointer',
  'border-radius': 'var(--radius-lg)',
  border: `1px solid ${theme.borderSubtle}`,
  background: `color-mix(in srgb, ${theme.fgSubtle} 6%, transparent)`,
  color: theme.fgSubtle,
  'user-select': 'none',
};

export function NewTaskPlaceholder() {
  let addTaskRef: HTMLDivElement | undefined;
  let addTerminalRef: HTMLDivElement | undefined;

  onMount(() => {
    registerFocusFn('placeholder:add-task', () => addTaskRef?.focus());
    registerFocusFn('placeholder:add-terminal', () => addTerminalRef?.focus());
    onCleanup(() => {
      unregisterFocusFn('placeholder:add-task');
      unregisterFocusFn('placeholder:add-terminal');
    });
  });

  return (
    <div
      style={{
        width: '48px',
        'min-width': '48px',
        height: 'calc(100% - 12px)',
        display: 'flex',
        'flex-direction': 'column',
        gap: '4px',
        margin: '6px 3px',
        'flex-shrink': '0',
      }}
    >
      {/* Add task button — fills remaining space */}
      <div
        ref={addTaskRef}
        class="new-task-placeholder"
        role="button"
        tabIndex={0}
        aria-label="New task"
        onClick={() => toggleNewTaskDialog(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleNewTaskDialog(true);
          }
        }}
        style={{ ...ghostStyle, flex: '1' }}
        title={`New task (${mod}+N)`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
        </svg>
      </div>

      {/* Terminal button — same width, fixed height */}
      <div
        ref={addTerminalRef}
        class="new-task-placeholder"
        role="button"
        tabIndex={0}
        aria-label="New terminal"
        onClick={() => createTerminal()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            unfocusPlaceholder();
            createTerminal();
          }
        }}
        style={{
          ...ghostStyle,
          height: '44px',
          'font-size': '12px',
          'font-family': 'var(--font-mono)',
          'flex-shrink': '0',
        }}
        title={`New terminal (${mod}+Shift+D)`}
      >
        &gt;_
      </div>
    </div>
  );
}

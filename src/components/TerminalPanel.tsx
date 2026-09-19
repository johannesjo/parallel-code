import { createEffect, onMount, onCleanup } from 'solid-js';
import {
  store,
  closeTerminal,
  updateTerminalName,
  activateTaskFromPointer,
  reorderTask,
  registerFocusFn,
  unregisterFocusFn,
  setTaskFocusedPanel,
  isPanelFocused,
} from '../store/store';
import { EditableText, type EditableTextHandle } from './EditableText';
import { IconButton } from './IconButton';
import { TerminalView } from './TerminalView';
import { CloseIcon } from './icons';
import { theme } from '../lib/theme';
import { handleDragReorder } from '../lib/dragReorder';
import type { Terminal } from '../store/types';
import { scheduleTaskFocus } from '../store/focused-panel';

interface TerminalPanelProps {
  terminal: Terminal;
  isActive: boolean;
}

export function TerminalPanel(props: TerminalPanelProps) {
  let panelRef!: HTMLDivElement;
  let titleEditHandle: EditableTextHandle | undefined;

  // Focus registration
  onMount(() => {
    const id = props.terminal.id;
    registerFocusFn(`${id}:title`, () => titleEditHandle?.startEdit());

    onCleanup(() => {
      unregisterFocusFn(`${id}:title`);
      unregisterFocusFn(`${id}:terminal`);
    });
  });

  // Respond to focus panel changes
  createEffect(() => {
    if (!props.isActive) return;
    const panel = store.focusedPanel[props.terminal.id] ?? 'terminal';
    scheduleTaskFocus(props.terminal.id, panel);
  });

  function handleTitleMouseDown(e: MouseEvent) {
    handleDragReorder(e, {
      itemId: props.terminal.id,
      getTaskOrder: () => store.taskOrder,
      onReorder: reorderTask,
      onTap: () => activateTaskFromPointer(props.terminal.id),
    });
  }

  return (
    <div
      ref={panelRef}
      class={`task-column ${props.isActive ? 'active' : ''}`}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: theme.taskContainerBg,
        'border-radius': '0',
        border: `1px solid ${theme.border}`,
        overflow: 'clip',
        position: 'relative',
      }}
      onClick={() => activateTaskFromPointer(props.terminal.id)}
    >
      {/* Title bar */}
      <div
        class={props.isActive ? 'island-header-active' : ''}
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '0 10px',
          height: '36px',
          'min-height': '36px',
          background: 'transparent',
          'border-bottom': `1px solid ${theme.border}`,
          'user-select': 'none',
          cursor: 'grab',
          'flex-shrink': '0',
        }}
        onMouseDown={handleTitleMouseDown}
      >
        <div
          style={{
            overflow: 'hidden',
            flex: '1',
            'min-width': '0',
            display: 'flex',
            'align-items': 'center',
            gap: '8px',
          }}
        >
          <span
            style={{
              'font-family': 'monospace',
              'font-size': '14px',
              color: theme.fgMuted,
              'flex-shrink': '0',
            }}
          >
            &gt;_
          </span>
          <EditableText
            value={props.terminal.name}
            onCommit={(v) => updateTerminalName(props.terminal.id, v)}
            class="editable-text"
            ref={(h) => (titleEditHandle = h)}
          />
        </div>
        <div style={{ display: 'flex', gap: '4px', 'margin-left': '8px', 'flex-shrink': '0' }}>
          <IconButton
            icon={<CloseIcon />}
            onClick={() => closeTerminal(props.terminal.id)}
            title="Close terminal"
          />
        </div>
      </div>

      {/* Terminal */}
      <div
        class="focusable-panel"
        data-panel-focused={isPanelFocused(props.terminal.id, 'terminal') ? 'true' : 'false'}
        style={{
          height: '100%',
          position: 'relative',
        }}
        onClick={() => setTaskFocusedPanel(props.terminal.id, 'terminal')}
      >
        <TerminalView
          taskId={props.terminal.id}
          agentId={props.terminal.agentId}
          isShell
          bookmarksEnabled={false}
          isFocused={isPanelFocused(props.terminal.id, 'terminal')}
          command=""
          args={['-l']}
          cwd=""
          onReady={(focusFn) => registerFocusFn(`${props.terminal.id}:terminal`, focusFn)}
          autoFocus
        />
      </div>
    </div>
  );
}

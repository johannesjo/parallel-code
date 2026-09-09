import { For, Show, createEffect, createSignal } from 'solid-js';
import {
  setTaskFocusedPanel,
  isPanelFocused,
  openCanvasDocument,
  activateCanvasTab,
  closeCanvasTab,
  closeTaskCanvas,
} from '../store/store';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { canvasTabKey, tabFromKey } from '../lib/canvas-tabs';
import type { Task } from '../store/types';
import { ConfirmDialog } from './ConfirmDialog';
import { CanvasFilePicker } from './CanvasFilePicker';
import { CanvasTabStrip } from './CanvasTabStrip';
import { TaskCanvasDocument } from './TaskCanvasDocument';

interface TaskCanvasPanelProps {
  task: Task;
  agentId: string;
}

/**
 * The task's canvas column: a tab per open document, all kept mounted so
 * edits survive switching, with a picker for adding Markdown files.
 */
export function TaskCanvasPanel(props: TaskCanvasPanelProps) {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [dirtyTabs, setDirtyTabs] = createSignal<Record<string, boolean>>({});
  // The tab a close was asked for while it had unsaved edits; null for the column.
  const [confirmClose, setConfirmClose] = createSignal<string | null | false>(false);

  const tabs = () => props.task.canvasTabs ?? [];
  const active = () => props.task.canvasActiveTab;

  // Nothing to show: the column opened from the title bar, so ask.
  createEffect(() => {
    if (tabs().length === 0) setPickerOpen(true);
  });

  const setDirty = (key: string, dirty: boolean) =>
    setDirtyTabs((d) => (d[key] === dirty ? d : { ...d, [key]: dirty }));

  function requestCloseTab(key: string): void {
    if (dirtyTabs()[key]) setConfirmClose(key);
    else closeCanvasTab(props.task.id, key);
  }

  function requestCloseAll(): void {
    if (Object.values(dirtyTabs()).some(Boolean)) setConfirmClose(null);
    else closeTaskCanvas(props.task.id);
  }

  function confirmedClose(): void {
    const target = confirmClose();
    setConfirmClose(false);
    if (typeof target === 'string') closeCanvasTab(props.task.id, target);
    else closeTaskCanvas(props.task.id);
  }

  return (
    <div
      class="focusable-panel"
      data-testid="task-canvas"
      data-panel-focused={isPanelFocused(props.task.id, 'canvas') ? 'true' : 'false'}
      onClick={() => setTaskFocusedPanel(props.task.id, 'canvas')}
      style={{
        height: '100%',
        display: 'flex',
        'flex-direction': 'column',
        position: 'relative',
        'border-left': `1px solid ${theme.border}`,
        background: theme.taskPanelBg,
      }}
    >
      {/* Strip and picker share one positioned box so the popover hangs
          under the strip, not under the whole column. */}
      <div style={{ position: 'relative', 'flex-shrink': '0' }}>
        <CanvasTabStrip
          tabs={tabs()}
          active={active()}
          dirty={dirtyTabs()}
          onActivate={(key) => activateCanvasTab(props.task.id, key)}
          onClose={requestCloseTab}
          onAdd={() => setPickerOpen(true)}
          onCloseAll={requestCloseAll}
        />
        <Show when={pickerOpen()}>
          <CanvasFilePicker
            worktreePath={props.task.worktreePath}
            current={tabs().map((t) => t.path)}
            onPick={(file) => {
              setPickerOpen(false);
              openCanvasDocument(props.task.id, file);
            }}
            onClose={() => setPickerOpen(false)}
          />
        </Show>
      </div>
      <Show when={tabs().length === 0}>
        <div
          style={{
            flex: '1',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            padding: '24px',
            'text-align': 'center',
            color: theme.fgMuted,
            'font-size': sf(12),
          }}
        >
          Open a Markdown file with +, or let the agent write one and it will appear here.
        </div>
      </Show>
      {/* Keyed by tab key, not object, so a document survives the list being rewritten. */}
      <For each={tabs().map(canvasTabKey)}>
        {(key) => (
          <Show when={tabFromKey(key)}>
            {(tab) => (
              <TaskCanvasDocument
                task={props.task}
                agentId={props.agentId}
                path={tab().path}
                active={active() === key}
                onDirty={(dirty) => setDirty(key, dirty)}
              />
            )}
          </Show>
        )}
      </For>
      <ConfirmDialog
        open={confirmClose() !== false}
        title="Discard edits?"
        message={
          typeof confirmClose() === 'string'
            ? 'This tab has unsaved edits. Close it and lose them?'
            : 'The canvas has unsaved edits. Close it and lose them?'
        }
        confirmLabel="Discard"
        danger
        onConfirm={confirmedClose}
        onCancel={() => setConfirmClose(false)}
      />
    </div>
  );
}

import { Show, type Accessor } from 'solid-js';
import type { MapData } from '../graph/model';
import type { NodeAction } from '../graph/NodeContextMenu';
import { canvasTaskPrompt, type CanvasTaskSource } from '../lib/canvas-task-links';
import { store, setStore } from '../store/core';
import { isHiddenAgentTaskId } from '../documents/task-id';
import {
  canvasTaskLink,
  canvasTaskPending,
  linkCanvasTask,
  unlinkCanvasTask,
} from '../store/canvas-tasks';
import { toggleNewTaskPanel, setActiveTask } from '../store/navigation';
import { uncollapseTask } from '../store/tasks';
import { getReadyLabel, getTaskAttentionState } from '../store/taskStatus';
import { getTaskFocusedPanel, setTaskFocusedPanel } from '../store/focused-panel';
import { showNotification } from '../store/notification';

const attentionLabels = {
  active: 'Running',
  shell_busy: 'Terminal busy',
  needs_input: 'Needs input',
  error: 'Error',
  review: 'Review',
  idle: 'Idle',
};

export function createCanvasTaskControls(context: Accessor<Omit<CanvasTaskSource, 'nodeId'>>) {
  const source = (nodeId: string): CanvasTaskSource => ({ ...context(), nodeId });
  function openTask(taskId: string) {
    if (!store.tasks[taskId] || store.tasks[taskId].closingStatus) return;
    if (store.tasks[taskId].collapsed) uncollapseTask(taskId);
    setActiveTask(taskId);
    setTaskFocusedPanel(taskId, getTaskFocusedPanel(taskId));
  }
  function status(nodeId: string): string {
    const ref = source(nodeId);
    if (canvasTaskPending(ref)) return 'Creating task…';
    const link = canvasTaskLink(ref);
    const task = link && store.tasks[link.taskId];
    if (!task) return 'Closed';
    if (task.closingStatus === 'error') return 'Close failed';
    if (task.closingStatus) return 'Closing';
    if (task.collapsed) return 'Collapsed';
    const attention = getTaskAttentionState(task.id);
    if (attention === 'ready') return getReadyLabel(task.id);
    if (attention !== 'idle') return attentionLabels[attention];
    if (task.agentIds.length && task.agentIds.every((id) => store.agents[id]?.status === 'exited'))
      return 'Stopped';
    return 'Idle';
  }
  function actions(nodeId: string, map: MapData & { revision: number }): NodeAction[] {
    const ref = source(nodeId);
    const link = canvasTaskLink(ref);
    if (link)
      return [
        {
          label: 'Open linked task',
          separator: true,
          disabled: !store.tasks[link.taskId] || !!store.tasks[link.taskId].closingStatus,
          run: () => openTask(link.taskId),
        },
        {
          label: 'Unlink task',
          title: 'Remove this link without stopping or closing the task',
          run: () => unlinkCanvasTask(ref),
        },
      ];
    const owner = store.tasks[ref.taskId];
    const disabled = !owner || !!owner.closingStatus || canvasTaskPending(ref);
    const candidates = Object.values(store.tasks).filter(
      (task) =>
        task.id !== ref.taskId &&
        task.projectId === owner?.projectId &&
        !task.closingStatus &&
        !isHiddenAgentTaskId(task.id),
    );
    return [
      {
        label: canvasTaskPending(ref) ? 'Creating task…' : 'Create task from branch…',
        separator: true,
        disabled: disabled || store.showNewTaskPanel,
        title: store.showNewTaskPanel
          ? 'Finish or close the open New Task form first'
          : 'Review the assignment and choose an agent',
        run: () => {
          if (store.showNewTaskPanel || !owner) return;
          const node = map.records.find((item) => item.id === nodeId);
          if (!node) return;
          setStore('newTaskDropUrl', null);
          setStore('newTaskPrefillPrompt', {
            name: node.title,
            prompt: canvasTaskPrompt(ref, map, map.revision),
            projectId: owner.projectId,
            baseBranch: owner.branchName || undefined,
            canvasSource: ref,
          });
          toggleNewTaskPanel(true);
        },
      },
      {
        label: 'Link existing task',
        disabled: disabled || !candidates.length,
        children: candidates.map((task) => ({
          label: task.name,
          run: () => {
            try {
              linkCanvasTask(ref, task.id);
            } catch (error) {
              showNotification(error instanceof Error ? error.message : String(error));
            }
          },
        })),
      },
    ];
  }
  function renderBadge(nodeId: string) {
    const link = () => canvasTaskLink(source(nodeId));
    const task = () => store.tasks[link()?.taskId ?? ''];
    return (
      <Show when={link() || canvasTaskPending(source(nodeId))}>
        <button
          type="button"
          class="graph-task-badge"
          disabled={!task() || !!task()?.closingStatus}
          title={task()?.name ?? link()?.taskName ?? 'Creating task'}
          aria-label={`${status(nodeId)}: ${task()?.name ?? link()?.taskName ?? 'task'}`}
          onPointerDown={(event) => event.stopPropagation()}
          onDblClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            const current = link();
            if (current) openTask(current.taskId);
          }}
        >
          {status(nodeId)} · {task()?.name ?? link()?.taskName ?? 'Task'}
        </button>
      </Show>
    );
  }
  return { actions, renderBadge };
}

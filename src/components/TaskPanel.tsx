import { setActiveTask, retryCloseTask } from '../store/store';
import { TaskAITerminal } from './TaskAITerminal';
import { TaskClosingOverlay } from './TaskClosingOverlay';
import type { Task } from '../store/types';

interface TaskPanelProps {
  task: Task;
  isActive: boolean;
}

export function TaskPanel(props: TaskPanelProps) {
  let panelRef!: HTMLDivElement;

  return (
    <div
      ref={panelRef}
      class={`task-column ${props.isActive ? 'active' : ''}`}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: 'var(--task-container-bg)',
        overflow: 'clip',
        position: 'relative',
      }}
      onClick={() => setActiveTask(props.task.id)}
    >
      <TaskClosingOverlay
        closingStatus={props.task.closingStatus}
        closingError={props.task.closingError}
        onRetry={() => retryCloseTask(props.task.id)}
      />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <TaskAITerminal task={props.task} isActive={props.isActive} />
      </div>
    </div>
  );
}

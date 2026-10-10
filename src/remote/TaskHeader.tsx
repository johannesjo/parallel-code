import { createSignal, Show, type JSX } from 'solid-js';
import { agentStatusDisplay } from './attention';
import { ConnectionBanner } from './ConnectionBanner';
import { FixCiDialog } from './FixCiDialog';
import { agents, canControl, status } from './ws';

/** Title, status and connection banners shared by a task's terminal and chat screens. */
export function TaskHeader(props: {
  agentId: string;
  taskName: string;
  onBack: () => void;
  onNeedsPairing: () => void;
  children?: JSX.Element;
}) {
  const agent = () => agents().find((a) => a.agentId === props.agentId);
  const display = () => agentStatusDisplay(agent() ?? { status: 'exited', attention: 'idle' });
  // The task id, held from the click: a reconnect blanking `agent()` must not drop the user's edits.
  const [fixingCiTask, setFixingCiTask] = createSignal<string>();
  return (
    <>
      <header class="mobile-header mobile-task-header">
        <button
          class="mobile-button quiet"
          onClick={() => props.onBack()}
          aria-label="Back to tasks"
        >
          ←
        </button>
        <div class="heading">
          <h1 title={props.taskName}>{props.taskName}</h1>
          <div class="mobile-task-meta">
            <p class="mobile-task-context">
              {[agent()?.projectName, agent()?.agentName].filter(Boolean).join(' · ')}
            </p>
            <span class="agent-status" style={{ color: display().color }}>
              <span class="status-dot" aria-hidden="true" />
              {display().label}
            </span>
          </div>
        </div>
        {props.children}
      </header>
      <ConnectionBanner />
      <Show when={status() === 'connected' && !canControl()}>
        <div class="mobile-banner info">
          <span>View only</span>
          <button class="mobile-button quiet" onClick={() => props.onNeedsPairing()}>
            Enable replies
          </button>
        </div>
      </Show>
      {/* Paired only: the prompt exists to be sent, which a view-only phone cannot do. */}
      <Show when={canControl() && agent()?.ci === 'failure' && agent()?.taskId}>
        {(taskId) => (
          <div class="mobile-banner error">
            <span>PR checks failed</span>
            <button class="mobile-button quiet" onClick={() => setFixingCiTask(taskId())}>
              Fix CI
            </button>
          </div>
        )}
      </Show>
      {/* Outside the banner's Show: a CI re-run mid-edit must not discard the user's edits. */}
      <Show when={fixingCiTask()}>
        {(taskId) => <FixCiDialog taskId={taskId()} onClose={() => setFixingCiTask()} />}
      </Show>
    </>
  );
}

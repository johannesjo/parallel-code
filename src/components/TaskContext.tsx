import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';
import type { PlanStepStatus } from '../../electron/shared/agent-plan';
import { formatRelativeAge } from '../lib/relativeAge';
import { taskGoal } from '../lib/task-plan';
import { store } from '../store/core';
import { refreshTaskBrief } from '../store/task-brief';
import { taskPlanView } from '../store/task-plan';
import type { Task } from '../store/types';
import './task-context.css';

// Functions, not elements: a JSX element is one DOM node, and sharing it would
// move the mark into whichever row rendered last.
const ICON_PATHS: Record<PlanStepStatus, () => JSX.Element> = {
  completed: () => (
    <path
      d="M5.2 8.2l1.9 1.9 3.7-3.9"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  ),
  in_progress: () => <path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />,
  pending: () => null,
};

function StepIcon(props: { status: PlanStepStatus }) {
  return (
    <svg class="ctx-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-dasharray={props.status === 'pending' ? '2.4 2.2' : undefined}
      />
      {ICON_PATHS[props.status]()}
    </svg>
  );
}

const STATUS_LABEL: Record<PlanStepStatus, string> = {
  completed: 'done',
  in_progress: 'in progress',
  pending: 'to do',
};

/** How fresh the brief is, or why there is none. */
function briefNote(task: Task, nowMs: number): string {
  const status = task.briefStatus;
  if (status?.state === 'generating') return 'Updating…';
  if (status?.state === 'failed') return `The brief could not be written: ${status.message}`;
  if (task.brief) return `Updated ${formatRelativeAge(task.brief.generatedAt, nowMs)}`;
  return 'The brief is written after each agent turn.';
}

/** Brief freshness and the task's routine actions, kept quiet at the bottom. */
function ContextFooter(props: TaskContextProps) {
  // Keeps "Updated 5m" current while the context stays on screen.
  const [nowMs, setNowMs] = createSignal(Date.now());
  const ticker = setInterval(() => setNowMs(Date.now()), 30_000);
  onCleanup(() => clearInterval(ticker));
  const briefs = () => store.taskBriefs && props.task.agentIds.length > 0;

  return (
    <Show when={briefs() || props.onWalkThrough}>
      <footer class="ctx-foot">
        <span class="ctx-foot-note">{briefs() ? briefNote(props.task, nowMs()) : ''}</span>
        <Show when={briefs()}>
          <button
            type="button"
            class="btn-secondary ctx-btn"
            disabled={props.task.briefStatus?.state === 'generating'}
            onClick={() => void refreshTaskBrief(props.task.id, { force: true })}
          >
            Update now
          </button>
        </Show>
        <Show when={props.onWalkThrough}>
          {(walk) => (
            <button
              type="button"
              class="btn-secondary ctx-btn"
              disabled={props.walkThroughDisabled}
              onClick={() => walk()()}
            >
              Walk me through
            </button>
          )}
        </Show>
      </footer>
    </Show>
  );
}

export interface TaskContextProps {
  task: Task;
  /** Opens the walkthrough of the task's changes. Left out where a tour button is already beside it. */
  onWalkThrough?: () => void;
  walkThroughDisabled?: boolean;
}

/**
 * Answers "what is this task for and where is it?": the goal, then the agent's
 * own plan, with only a failure as extra detail. Without a plan it falls back
 * to the brief's one-line status. Shown as a pane in the split task view and
 * in the plan line's popover in the stacked one.
 */
export function TaskContext(props: TaskContextProps) {
  const plan = () => taskPlanView(props.task.id);
  const done = () => plan().steps.filter((step) => step.status === 'completed').length;
  const goal = () => taskGoal(props.task);
  const now = () => props.task.brief?.brief.now ?? '';
  // The hint is only on hover: a visible sentence was noise in every fresh task.
  const emptyHint = () =>
    plan().steps.length === 0 && !now()
      ? "The agent's plan shows here once it writes a to-do list"
      : undefined;

  return (
    <section class="ctx" aria-label="Task context" title={emptyHint()}>
      <Show when={goal()}>
        <div class="ctx-goalbar">
          <span class="ctx-label">Goal</span>
          <span>{goal()}</span>
        </div>
      </Show>
      <Show
        when={plan().steps.length > 0}
        fallback={
          <Show when={now()}>
            <h3 class="ctx-head">Now</h3>
            <p class="ctx-now">{now()}</p>
          </Show>
        }
      >
        <h3 class="ctx-head">
          Plan{' '}
          <span class="ctx-count">
            {done()}/{plan().steps.length}
          </span>
        </h3>
        <ol class="ctx-track">
          <For each={plan().steps}>
            {(step) => (
              <li
                class={`ctx-row ctx-row--${step.status}`}
                aria-current={step.status === 'in_progress' ? 'step' : undefined}
              >
                <StepIcon status={step.status} />
                <div class="ctx-text">
                  <span>
                    {step.step}
                    <span class="ctx-sr">, {STATUS_LABEL[step.status]}</span>
                  </span>
                  <Show when={step.status === 'in_progress' && plan().failedCommand}>
                    {(command) => (
                      <span class="ctx-fail">
                        <code>{command()}</code> failed
                      </span>
                    )}
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <ContextFooter {...props} />
    </section>
  );
}

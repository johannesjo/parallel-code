import { Show } from 'solid-js';
import { agentStatusDisplay } from './attention';
import { TaskPr } from './TaskPr';
import { ProjectSwatch } from '../components/ProjectSwatch';
import { sanitizeProjectIcon } from '../lib/project-icon';
import type { RemoteAgent, RemoteAttentionState } from '../../electron/remote/protocol';

/** The button a waiting task's ask row offers, as on the desktop board card (ASK_ACTION). */
const ASK_ACTION: Partial<Record<RemoteAttentionState, string>> = {
  needs_input: 'Answer',
  error: 'Show error',
  review: 'Review',
};

interface TaskCardProps {
  agent: RemoteAgent;
  /** Filed under Needs you: the card says what it waits for and offers the way there. */
  asking: boolean;
  onOpen: () => void;
}

/**
 * One task, laid out like the desktop board card: the title button stretches
 * over the card, so a tap anywhere opens the task; the state dot leads the
 * title, then the project, the agent's last line, the PR and what it waits on.
 */
export function TaskCard(props: TaskCardProps) {
  // The PR row already spells out what the checks say, so the status does not repeat it.
  const display = () =>
    agentStatusDisplay(props.agent.pr?.label ? { ...props.agent, ci: undefined } : props.agent);
  const failed = () => props.agent.attention === 'error' || props.agent.pr?.kind === 'failed';
  // Failed CI has no ask row, as on the desktop: its PR row or status already says so.
  const action = () => (props.asking ? ASK_ACTION[props.agent.attention] : undefined);
  return (
    <li class="agent-card" classList={{ failed: failed() }}>
      <button type="button" class="agent-card-title" onClick={() => props.onOpen()}>
        <span
          class="status-dot"
          classList={{ glow: display().glow }}
          style={{ color: display().color }}
          aria-hidden="true"
        />
        <strong title={props.agent.taskName}>{props.agent.taskName}</strong>
      </button>
      <div class="agent-card-meta">
        <span class="agent-card-project">
          <Show when={props.agent.projectColor}>
            {(color) => (
              <ProjectSwatch
                color={color()}
                icon={sanitizeProjectIcon(props.agent.projectIcon)}
                size={10}
              />
            )}
          </Show>
          {[props.agent.projectName, props.agent.agentName].filter(Boolean).join(' · ') ||
            'Agent task'}
        </span>
        {/* The ask row names the state of a waiting task instead. */}
        <Show when={!action()}>
          <span class="agent-status">{display().label}</span>
        </Show>
      </div>
      {/* Always rendered so output starting or stopping never changes the card's height. */}
      <p
        class="agent-preview"
        title={props.agent.lastLine ? 'Recent terminal output' : undefined}
        aria-hidden={props.agent.lastLine ? undefined : 'true'}
      >
        {props.agent.lastLine || ' '}
      </p>
      <Show when={props.agent.pr}>{(pr) => <TaskPr pr={pr()} />}</Show>
      <Show when={action()}>
        {(label) => (
          <div class={`agent-ask ${props.agent.attention}`}>
            <span class="agent-ask-label">{display().label}</span>
            <button
              type="button"
              class="agent-ask-act"
              aria-label={`${label()}: ${props.agent.taskName}`}
              onClick={() => props.onOpen()}
            >
              {label()}
            </button>
          </div>
        )}
      </Show>
    </li>
  );
}

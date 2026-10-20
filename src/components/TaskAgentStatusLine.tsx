import { Show } from 'solid-js';
import { formatRelativeAge } from '../lib/relativeAge';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';
import { formatAgentHookTooltip, type TaskAgentHookStatus } from '../store/agentHookStatus';

interface TaskAgentStatusLineProps {
  status: TaskAgentHookStatus | null;
  nowMs: number;
}

export interface AgentStatusDescription {
  label: string;
  text: string;
  color: string;
}

/** One-line reading of a hook status: what the agent is doing, in the user's words. */
export function describeAgentStatus(status: TaskAgentHookStatus): AgentStatusDescription {
  if (status.state === 'waiting') {
    const text =
      status.detail ?? (status.toolName ? `${status.toolName} needs approval` : 'waiting for you');
    return { label: 'Needs you', text, color: theme.warning };
  }
  if (status.state === 'working') {
    const tool = status.toolName ? [status.toolName, status.detail].filter(Boolean).join(' ') : '';
    return { label: 'Working', text: tool || 'thinking', color: theme.fgMuted };
  }
  if (status.event === 'Interrupt') {
    return { label: 'Interrupted', text: '', color: theme.fgMuted };
  }
  if (status.event === 'SessionStart') {
    return { label: 'Session ready', text: '', color: theme.fgMuted };
  }
  if (status.event === 'StopFailure') {
    return {
      label: 'Turn failed',
      text: status.detail ?? status.lastAssistantMessage ?? '',
      color: theme.error,
    };
  }
  if (status.event === 'Stop') {
    return {
      label: 'Turn finished',
      text: status.lastAssistantMessage ?? '',
      color: theme.fgMuted,
    };
  }
  return { label: 'Ready for input', text: status.detail ?? '', color: theme.fgMuted };
}

/** Sidebar second line fed by hook events; nothing renders for agents without them. */
export function TaskAgentStatusLine(props: TaskAgentStatusLineProps) {
  return (
    <Show when={props.status}>
      {(status) => {
        const described = () => describeAgentStatus(status());
        const age = () => formatRelativeAge(status().since, props.nowMs);
        const title = () => formatAgentHookTooltip(status(), props.nowMs);
        return (
          <div
            class="task-agent-status"
            title={title()}
            aria-label={title()}
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '5px',
              'min-width': '0',
              color: theme.fgSubtle,
              'font-size': sf(10),
              'line-height': '1.4',
              overflow: 'hidden',
              'white-space': 'nowrap',
            }}
          >
            <span style={{ color: described().color, 'font-weight': '500', 'flex-shrink': '0' }}>
              {described().label}
            </span>
            <Show when={described().text}>
              <span aria-hidden="true" style={{ color: theme.fgSubtle, 'flex-shrink': '0' }}>
                ·
              </span>
              <span
                style={{
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'min-width': '0',
                  flex: '1',
                }}
              >
                {described().text}
              </span>
            </Show>
            <span style={{ 'flex-shrink': '0', 'margin-left': 'auto' }}>{age()}</span>
          </div>
        );
      }}
    </Show>
  );
}

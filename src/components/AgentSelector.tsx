import { For, Show, onCleanup, type JSX } from 'solid-js';
import { theme } from '../lib/theme';
import type { AgentDef } from '../ipc/types';
import { isAgentInstalled } from '../lib/default-agent';

interface AgentSelectorProps {
  agents: AgentDef[];
  selectedAgent: AgentDef | null;
  onSelect: (agent: AgentDef) => void;
  wrap?: boolean;
  /** Shown at the end of the label row, such as the model picker. */
  action?: JSX.Element;
}

/**
 * Roving-tabindex agent picker.
 * Only the selected agent is in the Tab order; Arrow keys move between agents.
 * Agents whose CLI is missing are hidden, except the selected one: it may be
 * the last one used, which can run inside a Docker image.
 * Once deselected it is hidden like the rest: picking it again means installing it.
 */
export function AgentSelector(props: AgentSelectorProps) {
  // By id: hiding a deselected missing agent shifts the indexes.
  const btnRefs = new Map<string, HTMLButtonElement>();
  const allowWrap = () => props.wrap ?? true;
  const agents = () =>
    props.agents.filter((agent) => isAgentInstalled(agent) || agent.id === props.selectedAgent?.id);

  function handleKeyDown(e: KeyboardEvent, idx: number) {
    const list = agents();
    let nextIdx: number | null = null;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextIdx = (idx + 1) % list.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextIdx = (idx - 1 + list.length) % list.length;
    }

    if (nextIdx !== null) {
      const next = list[nextIdx];
      props.onSelect(next);
      btnRefs.get(next.id)?.focus();
    }
  }

  return (
    <div data-nav-field="agent" style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      {/* The fixed height keeps the agents still when an action comes or goes. */}
      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'min-height': '26px' }}>
        <label
          style={{
            'font-size': '12px',
            color: theme.fgMuted,
            'text-transform': 'uppercase',
            'letter-spacing': '0.05em',
          }}
        >
          Agent
        </label>
        {props.action}
      </div>
      <div
        role="radiogroup"
        style={{
          display: 'flex',
          'flex-wrap': allowWrap() ? 'wrap' : 'nowrap',
          gap: '8px',
          'overflow-x': allowWrap() ? undefined : 'auto',
          'overflow-y': 'hidden',
          'padding-bottom': allowWrap() ? undefined : '2px',
        }}
      >
        <For each={agents()}>
          {(agent, i) => {
            const isSelected = () => props.selectedAgent?.id === agent.id;
            onCleanup(() => btnRefs.delete(agent.id));
            return (
              <button
                ref={(el) => btnRefs.set(agent.id, el)}
                type="button"
                role="radio"
                aria-checked={isSelected()}
                tabIndex={isSelected() ? 0 : -1}
                class={`agent-btn ${isSelected() ? 'selected' : ''}`}
                onClick={() => props.onSelect(agent)}
                onKeyDown={(e) => handleKeyDown(e, i())}
                style={{
                  flex: allowWrap() ? '0 1 auto' : '0 0 auto',
                  'min-width': '70px',
                  padding: '10px 8px',
                  background: isSelected() ? theme.bgSelected : theme.bgInput,
                  border: isSelected() ? `1px solid ${theme.accent}` : `1px solid ${theme.border}`,
                  'border-radius': 'var(--radius-md)',
                  color: theme.fg,
                  cursor: 'pointer',
                  'font-size': '13px',
                  'font-weight': isSelected() ? '500' : '400',
                  'text-align': 'center',
                  'white-space': 'nowrap',
                }}
              >
                {agent.name}
                <Show when={agent.available === false}>
                  <span
                    style={{
                      'font-size': '11px',
                      color: theme.fgMuted,
                      'margin-left': '4px',
                    }}
                  >
                    (not installed)
                  </span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}

import { createEffect, For, Show } from 'solid-js';
import { isAgentSupportedInMode } from '../../electron/shared/agent-support';
import { store } from '../store/store';
import { theme } from '../lib/theme';
import type { AgentDef } from '../ipc/types';

interface AgentSelectorProps {
  agents: AgentDef[];
  selectedAgent: AgentDef | null;
  onSelect: (agent: AgentDef) => void;
  wrap?: boolean;
  dockerMode?: boolean;
}

/**
 * Roving-tabindex agent picker.
 * Only the selected agent is in the Tab order; Arrow keys move between agents.
 */
export function AgentSelector(props: AgentSelectorProps) {
  const btnRefs = new Map<string, HTMLButtonElement>();
  const allowWrap = () => props.wrap ?? true;
  const supportedAgents = () =>
    props.agents.filter((agent) => isAgentSupportedInMode(agent.command, props.dockerMode));

  // Switching Docker off must not leave a hidden, unsupported agent selected.
  createEffect(() => {
    const selected = props.selectedAgent;
    if (selected && !isAgentSupportedInMode(selected.command, props.dockerMode)) {
      const fallback = supportedAgents()[0];
      if (fallback) props.onSelect(fallback);
    }
  });

  function handleKeyDown(e: KeyboardEvent, idx: number) {
    const agents = supportedAgents();
    let nextIdx: number | null = null;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextIdx = (idx + 1) % agents.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextIdx = (idx - 1 + agents.length) % agents.length;
    }

    if (nextIdx !== null) {
      props.onSelect(agents[nextIdx]);
      btnRefs.get(agents[nextIdx].id)?.focus();
    }
  }

  return (
    <div data-nav-field="agent" style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
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
        <For each={supportedAgents()}>
          {(agent, i) => {
            const isSelected = () => props.selectedAgent?.id === agent.id;
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
                  color: isSelected()
                    ? store.themePreset === 'graphite' ||
                      store.themePreset === 'minimal' ||
                      store.themePreset === 'zenburnesque'
                      ? '#ffffff'
                      : theme.accentText
                    : theme.fg,
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
      <Show when={supportedAgents().length < props.agents.length}>
        <span style={{ 'font-size': '11px', color: theme.fgMuted }}>
          Kimi Code is available in Docker mode only.
        </span>
      </Show>
    </div>
  );
}

import { For, Show } from 'solid-js';
import { store } from '../store/store';
import { theme } from '../lib/theme';
import type { AgentDef } from '../ipc/types';

interface AgentSelectorProps {
  agents: AgentDef[];
  selectedAgent: AgentDef | null;
  onSelect: (agent: AgentDef) => void;
}

/**
 * Roving-tabindex agent picker.
 * Only the selected agent is in the Tab order; Arrow keys move between agents.
 */
export function AgentSelector(props: AgentSelectorProps) {
  const btnRefs: HTMLButtonElement[] = [];

  function handleKeyDown(e: KeyboardEvent, idx: number) {
    const agents = props.agents;
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
      btnRefs[nextIdx]?.focus();
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
      <div role="radiogroup" style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '8px' }}>
        <For each={props.agents}>
          {(agent, i) => {
            const isSelected = () => props.selectedAgent?.id === agent.id;
            return (
              <button
                ref={(el) => (btnRefs[i()] = el)}
                type="button"
                role="radio"
                aria-checked={isSelected()}
                tabIndex={isSelected() ? 0 : -1}
                class={`agent-btn ${isSelected() ? 'selected' : ''}`}
                onClick={() => props.onSelect(agent)}
                onKeyDown={(e) => handleKeyDown(e, i())}
                style={{
                  flex: '0 1 auto',
                  'min-width': '70px',
                  padding: '10px 8px',
                  background: isSelected() ? theme.bgSelected : theme.bgInput,
                  border: isSelected() ? `1px solid ${theme.accent}` : `1px solid ${theme.border}`,
                  'border-radius': '8px',
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

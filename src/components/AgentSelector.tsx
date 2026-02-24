import { For } from 'solid-js';
import { store } from '../store/store';
import { theme } from '../lib/theme';
import type { AgentDef } from '../ipc/types';

interface AgentSelectorProps {
  agents: AgentDef[];
  selectedAgent: AgentDef | null;
  onSelect: (agent: AgentDef) => void;
}

export function AgentSelector(props: AgentSelectorProps) {
  return (
    <div data-nav-field="agent" style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <label
        style={{
          'font-size': '11px',
          color: theme.fgMuted,
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
        }}
      >
        Agent
      </label>
      <div style={{ display: 'flex', gap: '8px' }}>
        <For each={props.agents}>
          {(agent) => {
            const isSelected = () => props.selectedAgent?.id === agent.id;
            return (
              <button
                type="button"
                class={`agent-btn ${isSelected() ? 'selected' : ''}`}
                onClick={() => props.onSelect(agent)}
                style={{
                  flex: '1',
                  padding: '10px 8px',
                  background: isSelected() ? theme.bgSelected : theme.bgInput,
                  border: isSelected() ? `1px solid ${theme.accent}` : `1px solid ${theme.border}`,
                  'border-radius': '8px',
                  color: isSelected()
                    ? store.themePreset === 'graphite' || store.themePreset === 'minimal'
                      ? '#ffffff'
                      : theme.accentText
                    : theme.fg,
                  cursor: 'pointer',
                  'font-size': '12px',
                  'font-weight': isSelected() ? '500' : '400',
                  'text-align': 'center',
                }}
              >
                {agent.name}
                {agent.available === false && (
                  <span
                    style={{
                      'font-size': '10px',
                      color: theme.fgMuted,
                      'margin-left': '4px',
                    }}
                  >
                    (not installed)
                  </span>
                )}
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}

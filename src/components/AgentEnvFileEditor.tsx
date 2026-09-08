import { For } from 'solid-js';
import { store, setAgentEnvFile } from '../store/store';
import { theme } from '../lib/theme';

/**
 * Lets each agent point at a `KEY=VALUE` file supplying credentials its CLI needs
 * (ANTHROPIC_API_KEY, CODEX_API_KEY, ANTHROPIC_CUSTOM_HEADERS, …). Only the path is
 * persisted — secrets stay in the file, and the file is re-read on every spawn.
 */
export function AgentEnvFileEditor() {
  const inputStyle = () => ({
    padding: '6px 8px',
    background: theme.bgInput,
    border: `1px solid ${theme.border}`,
    'border-radius': 'var(--radius-sm)',
    color: theme.fg,
    'font-size': '12px',
    'font-family': "'JetBrains Mono', monospace",
    width: '100%',
    'box-sizing': 'border-box' as const,
  });

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <div style={{ 'font-size': '12px', color: theme.fgSubtle, 'line-height': '1.5' }}>
        Environment variables for agents whose CLI needs an API key or custom headers. Point an
        agent at a file of <code>KEY=VALUE</code> lines — it is read fresh on every spawn, so edits
        apply to the next terminal without restarting the app. Same syntax as a <code>.env</code>{' '}
        file, so quote any value containing <code>#</code> or newlines, e.g.{' '}
        <code>ANTHROPIC_CUSTOM_HEADERS="x-api-key: abc\nx-tenant: acme"</code>. Keep the file
        outside your repos — anything that can write it runs code as the agent.
      </div>

      <For each={store.availableAgents.filter((a) => a.available !== false)}>
        {(agent) => (
          <label style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
            <span
              style={{
                'font-size': '13px',
                color: theme.fg,
                width: '130px',
                'flex-shrink': '0',
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
                'white-space': 'nowrap',
              }}
              title={agent.name}
            >
              {agent.name}
            </span>
            <input
              type="text"
              placeholder="~/.config/parallel-code/claude.env (optional)"
              value={store.agentEnvFiles[agent.id] ?? ''}
              onInput={(e) => setAgentEnvFile(agent.id, e.currentTarget.value)}
              style={inputStyle()}
            />
          </label>
        )}
      </For>
    </div>
  );
}

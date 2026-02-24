import { For, Show, createSignal } from 'solid-js';
import { store, addCustomAgent, removeCustomAgent } from '../store/store';
import { theme } from '../lib/theme';
import type { AgentDef } from '../ipc/types';

export function CustomAgentEditor() {
  const [showForm, setShowForm] = createSignal(false);
  const [name, setName] = createSignal('');
  const [command, setCommand] = createSignal('');
  const [resumeArgs, setResumeArgs] = createSignal('');
  const [skipArgs, setSkipArgs] = createSignal('');

  function handleAdd() {
    const n = name().trim();
    const cmd = command().trim();
    if (!n || !cmd) return;

    const id = n
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const agent: AgentDef = {
      id: `custom-${id}`,
      name: n,
      command: cmd,
      args: [],
      resume_args: resumeArgs().trim() ? resumeArgs().trim().split(/\s+/) : [],
      skip_permissions_args: skipArgs().trim() ? skipArgs().trim().split(/\s+/) : [],
      description: `Custom agent: ${n}`,
    };
    addCustomAgent(agent);
    setName('');
    setCommand('');
    setResumeArgs('');
    setSkipArgs('');
    setShowForm(false);
  }

  const inputStyle = () => ({
    padding: '8px 10px',
    background: theme.bgInput,
    border: `1px solid ${theme.border}`,
    'border-radius': '6px',
    color: theme.fg,
    'font-size': '12px',
    width: '100%',
    'box-sizing': 'border-box' as const,
  });

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <For each={store.customAgents}>
        {(agent) => (
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              padding: '8px 12px',
              'border-radius': '8px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
            }}
          >
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
              <span style={{ 'font-size': '13px', color: theme.fg }}>{agent.name}</span>
              <span
                style={{
                  'font-size': '11px',
                  color: theme.fgSubtle,
                  'font-family': "'JetBrains Mono', monospace",
                }}
              >
                {agent.command}
              </span>
            </div>
            <button
              type="button"
              onClick={() => removeCustomAgent(agent.id)}
              style={{
                background: 'transparent',
                border: 'none',
                color: theme.fgMuted,
                cursor: 'pointer',
                'font-size': '16px',
                padding: '0 4px',
              }}
            >
              &times;
            </button>
          </div>
        )}
      </For>

      <Show when={!showForm()}>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          style={{
            padding: '8px 12px',
            background: 'transparent',
            border: `1px dashed ${theme.border}`,
            'border-radius': '8px',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '12px',
          }}
        >
          + Add custom agent
        </button>
      </Show>

      <Show when={showForm()}>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            padding: '12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <input
            type="text"
            placeholder="Name (e.g. OpenCode)"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            style={inputStyle()}
          />
          <input
            type="text"
            placeholder="Command (e.g. opencode)"
            value={command()}
            onInput={(e) => setCommand(e.currentTarget.value)}
            style={inputStyle()}
          />
          <input
            type="text"
            placeholder="Resume args (optional, space-separated)"
            value={resumeArgs()}
            onInput={(e) => setResumeArgs(e.currentTarget.value)}
            style={inputStyle()}
          />
          <input
            type="text"
            placeholder="Skip permissions args (optional, space-separated)"
            value={skipArgs()}
            onInput={(e) => setSkipArgs(e.currentTarget.value)}
            style={inputStyle()}
          />
          <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              style={{
                padding: '6px 14px',
                background: 'transparent',
                border: `1px solid ${theme.border}`,
                'border-radius': '6px',
                color: theme.fgMuted,
                cursor: 'pointer',
                'font-size': '12px',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              style={{
                padding: '6px 14px',
                background: theme.accent,
                border: 'none',
                'border-radius': '6px',
                color: '#fff',
                cursor: 'pointer',
                'font-size': '12px',
                opacity: name().trim() && command().trim() ? 1 : 0.5,
              }}
            >
              Add Agent
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

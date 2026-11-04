import { For, Show, createSignal } from 'solid-js';
import { store, addCustomAgent, removeCustomAgent } from '../store/store';
import { theme } from '../lib/theme';
import type { AgentDef } from '../ipc/types';
import { PlusIcon } from './icons';

const compactButtonStyle = {
  padding: '6px 14px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border)',
  'border-radius': 'var(--radius-sm)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  'font-size': '13px',
};

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
    'border-radius': 'var(--radius-sm)',
    color: theme.fg,
    'font-size': '13px',
    width: '100%',
    'box-sizing': 'border-box' as const,
  });

  const labelStyle = () => ({
    display: 'flex',
    'flex-direction': 'column' as const,
    gap: '4px',
    color: theme.fgMuted,
    'font-size': '12px',
  });

  const canAdd = () => name().trim().length > 0 && command().trim().length > 0;

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
              'border-radius': 'var(--radius-md)',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
            }}
          >
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
              <span style={{ 'font-size': '14px', color: theme.fg }}>{agent.name}</span>
              <span
                style={{
                  'font-size': '12px',
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
                'font-size': '17px',
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
          class="btn-with-icon"
          type="button"
          onClick={() => setShowForm(true)}
          style={{
            padding: '8px 12px',
            background: 'transparent',
            border: `1px dashed ${theme.border}`,
            'border-radius': 'var(--radius-md)',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '13px',
          }}
        >
          <PlusIcon size={14} />
          Add custom agent
        </button>
      </Show>

      <Show when={showForm()}>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            padding: '12px',
            'border-radius': 'var(--radius-md)',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <label style={labelStyle()}>
            Name
            <input
              type="text"
              placeholder="e.g. OpenCode"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              style={inputStyle()}
            />
          </label>
          <label style={labelStyle()}>
            Command
            <input
              type="text"
              placeholder="e.g. opencode"
              value={command()}
              onInput={(e) => setCommand(e.currentTarget.value)}
              style={inputStyle()}
            />
          </label>
          <label style={labelStyle()}>
            Resume args
            <input
              type="text"
              placeholder="optional, space-separated"
              value={resumeArgs()}
              onInput={(e) => setResumeArgs(e.currentTarget.value)}
              style={inputStyle()}
            />
          </label>
          <label style={labelStyle()}>
            Skip permissions args
            <input
              type="text"
              placeholder="optional, space-separated"
              value={skipArgs()}
              onInput={(e) => setSkipArgs(e.currentTarget.value)}
              style={inputStyle()}
            />
          </label>
          <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
            <button
              type="button"
              class="btn-secondary"
              onClick={() => setShowForm(false)}
              style={compactButtonStyle}
            >
              Cancel
            </button>
            <button
              class="btn-primary btn-with-icon"
              type="button"
              disabled={!canAdd()}
              title={canAdd() ? undefined : 'Enter a name and a command'}
              onClick={handleAdd}
              style={{
                ...compactButtonStyle,
                cursor: canAdd() ? 'pointer' : 'not-allowed',
                opacity: canAdd() ? '1' : '0.5',
              }}
            >
              <PlusIcon size={14} />
              Add Agent
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

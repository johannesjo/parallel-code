import { For, Show, createSignal } from 'solid-js';
import {
  store,
  addCustomAgent,
  updateCustomAgent,
  removeCustomAgent,
  type CustomAgentFields,
} from '../store/store';
import { theme } from '../lib/theme';
import type { AgentDef } from '../ipc/types';
import { PlusIcon } from './icons';
import { customAgentId, splitAgentArgs } from '../lib/custom-agents';

const compactButtonStyle = {
  padding: '6px 14px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border)',
  'border-radius': 'var(--radius-sm)',
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  'font-size': '13px',
};

function AgentForm(props: {
  initial?: AgentDef;
  submitLabel: string;
  onSubmit: (fields: CustomAgentFields) => void;
  onCancel: () => void;
}) {
  // A one-time prefill: the form edits its own copy until it is saved.
  const [name, setName] = createSignal(props.initial?.name ?? '');
  const [command, setCommand] = createSignal(props.initial?.command ?? '');
  const [args, setArgs] = createSignal(props.initial?.args?.join(' ') ?? '');
  const [resumeArgs, setResumeArgs] = createSignal(props.initial?.resume_args?.join(' ') ?? '');
  const [skipArgs, setSkipArgs] = createSignal(
    props.initial?.skip_permissions_args?.join(' ') ?? '',
  );

  const canSubmit = () => name().trim().length > 0 && command().trim().length > 0;

  function submit() {
    if (!canSubmit()) return;
    props.onSubmit({
      name: name().trim(),
      command: command().trim(),
      args: splitAgentArgs(args()),
      resume_args: splitAgentArgs(resumeArgs()),
      skip_permissions_args: splitAgentArgs(skipArgs()),
    });
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

  const field = (
    label: string,
    placeholder: string,
    value: () => string,
    setValue: (value: string) => void,
  ) => (
    <label style={labelStyle()}>
      {label}
      <input
        type="text"
        placeholder={placeholder}
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        style={inputStyle()}
      />
    </label>
  );

  return (
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
      {field('Name', 'e.g. Kimi', name, setName)}
      {field('Command', 'e.g. kimi or /usr/local/bin/kimi', command, setCommand)}
      {field('Launch args', 'optional, space-separated, e.g. --model k2', args, setArgs)}
      {field(
        'Resume args',
        'optional, used instead of launch args to continue a session',
        resumeArgs,
        setResumeArgs,
      )}
      {field(
        'Skip permissions args',
        'optional, added when a task skips permissions',
        skipArgs,
        setSkipArgs,
      )}
      <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
        Arguments are split on spaces; quotes are not supported.
        <Show when={props.initial}> Changes apply the next time an agent starts or restarts.</Show>
      </span>
      <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
        <button
          type="button"
          class="btn-secondary"
          onClick={() => props.onCancel()}
          style={compactButtonStyle}
        >
          Cancel
        </button>
        <button
          class="btn-primary btn-with-icon"
          type="button"
          disabled={!canSubmit()}
          title={canSubmit() ? undefined : 'Enter a name and a command'}
          onClick={submit}
          style={{
            ...compactButtonStyle,
            cursor: canSubmit() ? 'pointer' : 'not-allowed',
            opacity: canSubmit() ? '1' : '0.5',
          }}
        >
          <Show when={!props.initial}>
            <PlusIcon size={14} />
          </Show>
          {props.submitLabel}
        </button>
      </div>
    </div>
  );
}

export function CustomAgentEditor() {
  const [adding, setAdding] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);

  function startAdding() {
    setEditingId(null);
    setAdding(true);
  }

  function startEditing(id: string) {
    setAdding(false);
    setEditingId(id);
  }

  function add(fields: CustomAgentFields) {
    const id = customAgentId(
      fields.name,
      store.customAgents.map((a) => a.id),
    );
    addCustomAgent({ ...fields, id, description: `Custom agent: ${fields.name}` });
    setAdding(false);
  }

  const rowButtonStyle = {
    background: 'transparent',
    border: 'none',
    color: theme.fgMuted,
    cursor: 'pointer',
    padding: '0 4px',
  };

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <For each={store.customAgents}>
        {(agent) => (
          <Show
            when={editingId() === agent.id}
            fallback={
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'space-between',
                  gap: '8px',
                  padding: '8px 12px',
                  'border-radius': 'var(--radius-md)',
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '2px',
                    'min-width': 0,
                  }}
                >
                  <span style={{ 'font-size': '14px', color: theme.fg }}>{agent.name}</span>
                  <span
                    style={{
                      'font-size': '12px',
                      color: theme.fgSubtle,
                      'font-family': "'JetBrains Mono', monospace",
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                      'white-space': 'nowrap',
                    }}
                  >
                    {[agent.command, ...(agent.args ?? [])].join(' ')}
                  </span>
                </div>
                <div style={{ display: 'flex', 'align-items': 'center', 'flex-shrink': 0 }}>
                  <button
                    type="button"
                    onClick={() => startEditing(agent.id)}
                    aria-label={`Edit ${agent.name}`}
                    style={{ ...rowButtonStyle, 'font-size': '13px' }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => removeCustomAgent(agent.id)}
                    aria-label={`Remove ${agent.name}`}
                    title="Remove"
                    style={{ ...rowButtonStyle, 'font-size': '17px' }}
                  >
                    &times;
                  </button>
                </div>
              </div>
            }
          >
            <AgentForm
              initial={agent}
              submitLabel="Save"
              onSubmit={(fields) => {
                updateCustomAgent(agent.id, fields);
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
            />
          </Show>
        )}
      </For>

      <Show
        when={adding()}
        fallback={
          <button
            class="btn-with-icon"
            type="button"
            onClick={startAdding}
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
        }
      >
        <AgentForm submitLabel="Add Agent" onSubmit={add} onCancel={() => setAdding(false)} />
      </Show>
    </div>
  );
}

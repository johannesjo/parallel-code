import { createSignal, For } from 'solid-js';
import type { RunCommand } from '../store/types';
import { theme } from '../lib/theme';
import { RUN_NAME_MAX_LENGTH } from '../lib/run-commands';
import { CloseIcon, PlusIcon } from './icons';
import { ProjectField, projectButtonStyle, projectMonoInputStyle } from './ProjectDialogParts';

interface ProjectRunCommandsFieldProps {
  runs: RunCommand[];
  onChange: (runs: RunCommand[]) => void;
}

const rowTextStyle = {
  overflow: 'hidden',
  'text-overflow': 'ellipsis',
  'white-space': 'nowrap',
  'font-size': '12px',
} as const;

/** Named dev servers: a removable list and inputs to add one. */
export function ProjectRunCommandsField(props: ProjectRunCommandsFieldProps) {
  const [name, setName] = createSignal('');
  const [command, setCommand] = createSignal('');
  const [url, setUrl] = createSignal('');
  const canAdd = () => !!name().trim() && !!command().trim();

  function add() {
    if (!canAdd()) return;
    const link = url().trim();
    const run: RunCommand = { id: crypto.randomUUID(), name: name().trim(), command: command() };
    props.onChange([...props.runs, link ? { ...run, url: link } : run]);
    setName('');
    setCommand('');
    setUrl('');
  }

  const onEnter = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    add();
  };

  return (
    <ProjectField
      label="Run commands"
      hint={
        <>
          Each appears in a task's shell toolbar to start, stop and restart in its own terminal.
          Every task gets its own block of 10 ports, the first in $PARALLEL_CODE_PORT: use it in the
          command and link, e.g. <code>npm run dev -- --port $PARALLEL_CODE_PORT</code> and{' '}
          <code>localhost:$PARALLEL_CODE_PORT</code>. In cmd.exe write %PARALLEL_CODE_PORT%.
        </>
      }
    >
      {(id) => (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
          <For each={props.runs}>
            {(run) => (
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '8px',
                  padding: '4px 4px 4px 12px',
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': 'var(--radius-sm)',
                }}
              >
                <span style={{ ...rowTextStyle, 'flex-shrink': '0', 'max-width': '30%' }}>
                  {run.name}
                </span>
                <span
                  title={run.url ? `${run.command}\n${run.url}` : run.command}
                  style={{
                    ...rowTextStyle,
                    flex: '1',
                    'font-family': "'JetBrains Mono', monospace",
                    color: theme.fgMuted,
                  }}
                >
                  {run.command}
                  {run.url ? ` → ${run.url}` : ''}
                </span>
                <button
                  type="button"
                  class="icon-btn"
                  aria-label={`Remove run command ${run.name}`}
                  title="Remove run command"
                  onClick={() => props.onChange(props.runs.filter((r) => r.id !== run.id))}
                  style={{
                    display: 'inline-flex',
                    background: 'transparent',
                    border: 'none',
                    color: theme.fgSubtle,
                    cursor: 'pointer',
                    padding: '4px',
                  }}
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            )}
          </For>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              id={id}
              class="input-field"
              type="text"
              aria-label="Run command name"
              maxLength={RUN_NAME_MAX_LENGTH}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={onEnter}
              placeholder="Name, e.g. web"
              style={{ ...projectMonoInputStyle, width: '120px', 'flex-shrink': '0' }}
            />
            <input
              class="input-field"
              type="text"
              aria-label="Run command"
              value={command()}
              onInput={(e) => setCommand(e.currentTarget.value)}
              onKeyDown={onEnter}
              placeholder="npm run dev -- --port $PARALLEL_CODE_PORT"
              style={{ ...projectMonoInputStyle, flex: '1', 'min-width': '0' }}
            />
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              class="input-field"
              type="text"
              aria-label="Run command link (optional)"
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
              onKeyDown={onEnter}
              placeholder="Link (optional), e.g. localhost:$PARALLEL_CODE_PORT"
              style={{ ...projectMonoInputStyle, flex: '1', 'min-width': '0' }}
            />
            <button
              class="btn-with-icon btn-secondary"
              type="button"
              onClick={add}
              disabled={!canAdd()}
              style={{
                ...projectButtonStyle,
                'border-radius': 'var(--radius-md)',
                cursor: canAdd() ? 'pointer' : 'not-allowed',
                opacity: canAdd() ? '1' : '0.5',
              }}
            >
              <PlusIcon size={14} />
              Add
            </button>
          </div>
        </div>
      )}
    </ProjectField>
  );
}

import { Index } from 'solid-js';
import { theme } from '../lib/theme';
import { CloseIcon, PlusIcon } from './icons';
import { ProjectField, projectButtonStyle, projectMonoInputStyle } from './ProjectDialogParts';
import type { EnvDraft } from './project-env-drafts';

interface ProjectEnvVarsFieldProps {
  drafts: EnvDraft[];
  error: string;
  onChange: (drafts: EnvDraft[]) => void;
}

/** `KEY=value` rows for the env vars this project's agents start with. */
export function ProjectEnvVarsField(props: ProjectEnvVarsFieldProps) {
  const edit = (id: string, change: Partial<EnvDraft>) =>
    props.onChange(props.drafts.map((d) => (d.id === id ? { ...d, ...change } : d)));

  return (
    <ProjectField
      label="Environment variables"
      hint={
        <>
          Set for agents and shells started in this project's tasks and sub-tasks after you save,
          and for the app's own agent calls there, such as briefs, reviews and tours. For example,{' '}
          <code>CLAUDE_CONFIG_DIR=~/.claude-work</code> uses another Claude account. A leading ~
          expands to your home folder. Not passed into Docker containers. PATH, HOME and SHELL can't
          be changed here. Values are stored unencrypted in the app's settings, so put API keys in
          an env file under Settings, Agent environment.
        </>
      }
    >
      {(id) => (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          {/* Index, not For: editing replaces the row object, and For would
              re-create the row and drop focus on every keystroke. */}
          <Index each={props.drafts}>
            {(draft, index) => (
              <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                <input
                  id={index === 0 ? id : undefined}
                  class="input-field"
                  type="text"
                  aria-label="Variable name"
                  placeholder="NAME"
                  spellcheck={false}
                  autocomplete="off"
                  value={draft().key}
                  onInput={(e) => edit(draft().id, { key: e.currentTarget.value })}
                  style={{ ...projectMonoInputStyle, flex: '2', 'min-width': '0' }}
                />
                <span aria-hidden="true" style={{ color: theme.fgSubtle }}>
                  =
                </span>
                <input
                  class="input-field"
                  type="text"
                  aria-label={`Value of ${draft().key.trim() || 'variable'}`}
                  placeholder="value"
                  spellcheck={false}
                  autocomplete="off"
                  value={draft().value}
                  onInput={(e) => edit(draft().id, { value: e.currentTarget.value })}
                  style={{ ...projectMonoInputStyle, flex: '3', 'min-width': '0' }}
                />
                <button
                  type="button"
                  class="icon-btn"
                  aria-label={`Remove ${draft().key.trim() || 'variable'}`}
                  title="Remove variable"
                  onClick={() => props.onChange(props.drafts.filter((d) => d.id !== draft().id))}
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
          </Index>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
            <button
              id={props.drafts.length === 0 ? id : undefined}
              class="btn-with-icon btn-secondary"
              type="button"
              onClick={() =>
                props.onChange([...props.drafts, { id: crypto.randomUUID(), key: '', value: '' }])
              }
              style={{
                ...projectButtonStyle,
                'border-radius': 'var(--radius-md)',
                cursor: 'pointer',
              }}
            >
              <PlusIcon size={14} />
              Add variable
            </button>
            {/* Space stays reserved so an error coming or going never moves the hint below. */}
            <span
              role="alert"
              title={props.error || undefined}
              style={{
                visibility: props.error ? 'visible' : 'hidden',
                flex: '1',
                'min-width': '0',
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
                'white-space': 'nowrap',
                'font-size': '12px',
                color: theme.error,
                'min-height': '1.45em',
              }}
            >
              {props.error}
            </span>
          </div>
        </div>
      )}
    </ProjectField>
  );
}

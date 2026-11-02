import { ModelMenu } from './ModelMenu';
import { ASK_CODE_CLAUDE_MODELS } from '../../electron/shared/ask-code-models';
import { reasoningEffortLabel } from '../../electron/shared/chat-messages';
import { codexModels, loadCodexModels } from '../lib/codex-models';
import { effortInArgs, modelInArgs } from '../lib/agent-args';
import { effortChoices } from './AgentModelMenu';
import { theme } from '../lib/theme';
import type { AgentDef } from '../ipc/types';

/** Claude Code and Codex take a model and reasoning level; other agents keep their own args. */
export function modelProvider(agent: AgentDef): 'claude' | 'codex' | undefined {
  const name = agent.command.split('/').pop();
  return name === 'claude' || name === 'codex' ? name : undefined;
}

/**
 * Model and reasoning level for a new task. Empty means "Default": no flag is
 * added, so the agent runs whatever its own args or CLI configure.
 */
export function NewTaskModelPicker(props: {
  agent: AgentDef;
  provider: 'claude' | 'codex';
  model: string;
  effort: string;
  onChange: (model: string, effort: string) => void;
}) {
  const models = () =>
    props.provider === 'claude'
      ? ASK_CODE_CLAUDE_MODELS.map((model) => ({ value: model, label: model }))
      : codexModels().map((model) => ({
          value: model.slug,
          label: model.displayName,
          title: model.slug,
        }));
  const efforts = (model: string) => effortChoices(props.provider, model);
  const defaultLabel = (configured: string) => (configured ? `Default (${configured})` : 'Default');
  // Names only what is set: the chosen value, else what the agent's own args set.
  const modelText = () =>
    models().find((choice) => choice.value === props.model)?.label ||
    props.model ||
    modelInArgs(props.agent.args) ||
    'Default model';
  const effortText = () => {
    const effort = props.effort || effortInArgs(props.agent.args);
    return effort ? ` · ${reasoningEffortLabel(effort)}` : '';
  };
  return (
    <ModelMenu
      label="Task model"
      text={`${modelText()}${effortText()}`}
      title="Model and reasoning level this task's agent starts with"
      class="btn-secondary btn-with-icon"
      groups={[
        {
          heading: props.provider === 'claude' ? 'Claude Code' : 'Codex',
          choices: [{ value: '', label: defaultLabel(modelInArgs(props.agent.args)) }, ...models()],
        },
      ]}
      value={props.model}
      // A level the new model does not take falls back to the default.
      onSelect={(model) =>
        props.onChange(model, efforts(model).includes(props.effort) ? props.effort : '')
      }
      section={{
        heading: 'Reasoning',
        choices: [
          { value: '', label: defaultLabel(effortInArgs(props.agent.args)) },
          ...efforts(props.model).map((value) => ({
            value,
            label: reasoningEffortLabel(value),
          })),
        ],
        value: props.effort,
        onSelect: (effort) => props.onChange(props.model, effort),
      }}
      onOpen={loadCodexModels}
      // Matches the prompt's From GitHub button: a routine action stays quiet.
      style={{
        'margin-left': 'auto',
        'flex-shrink': '0',
        'white-space': 'nowrap',
        padding: '4px 10px 4px 12px',
        background: 'transparent',
        border: `1px solid ${theme.border}`,
        'border-radius': 'var(--radius-sm)',
        color: theme.fgMuted,
        'font-size': '12px',
        cursor: 'pointer',
      }}
    />
  );
}

import type { JSX } from 'solid-js';
import { ModelMenu } from './ModelMenu';
import {
  ASK_CODE_CLAUDE_MODELS,
  ASK_CODE_MINIMAX_MODELS,
  askCodeEfforts,
  type AskCodeProvider,
} from '../../electron/shared/ask-code-models';
import { reasoningEffortLabel } from '../../electron/shared/chat-messages';
import { effortToRun, modelToRun } from '../lib/ask-code-model';
import { codexModels, loadCodexModels } from '../lib/codex-models';
import { store } from '../store/core';
import { setAskCodeEffort, setAskCodeModel, setAskCodeProvider } from '../store/store';
import { askCodeLabel } from './understanding/ask-code-label';
import { defaultAskCodeModel } from '../../electron/shared/ask-code-models';

interface ModelChoice {
  provider: AskCodeProvider;
  model: string;
  label: string;
  /** Shown on hover where the label is a display name, not the slug sent to the CLI. */
  title?: string;
}

interface ModelGroup {
  provider: AskCodeProvider;
  heading: string;
  choices: ModelChoice[];
  /** Shown in place of the rows when a provider offers nothing. */
  empty?: string;
}

/**
 * The providers in one flat list, so arrow keys walk them in the order shown.
 * Codex models come from its CLI cache, so that group can be empty.
 */
function groups(): ModelGroup[] {
  return [
    {
      provider: 'claude',
      heading: 'Claude Code',
      choices: ASK_CODE_CLAUDE_MODELS.map((model) => ({
        provider: 'claude' as const,
        model,
        label: model,
      })),
    },
    {
      provider: 'codex',
      heading: 'Codex',
      choices: codexModels().map((model) => ({
        provider: 'codex' as const,
        model: model.slug,
        label: model.displayName,
        title: model.slug,
      })),
      empty: 'No Codex models found',
    },
    {
      provider: 'minimax',
      heading: 'MiniMax',
      choices: ASK_CODE_MINIMAX_MODELS.map((model) => ({
        provider: 'minimax' as const,
        model,
        label: model,
      })),
    },
  ];
}

/**
 * Reasoning levels for a provider's model. Codex models differ, so Codex offers
 * only what its cache lists: the picked model's levels, or for the CLI's default
 * model the levels every listed model takes. Without that list it offers none.
 */
function effortChoices(provider: AskCodeProvider, model: string): readonly string[] {
  const known = askCodeEfforts(provider);
  if (provider !== 'codex') return known;
  const listed = codexModels().filter((choice) => !model || choice.slug === model);
  if (listed.length === 0) return [];
  return known.filter((effort) => listed.every((choice) => choice.efforts?.includes(effort)));
}

/**
 * The level a provider's model runs at: the remembered one if the model takes
 * it, else the one the launch sets itself, else the one requests then name. A
 * level the model does not take stays remembered for the next model that does.
 */
export function chosenEffort(provider: AskCodeProvider, model: string, configured = ''): string {
  const effort = store.askCodeEffort[provider] ?? '';
  const remembered = effortChoices(provider, model).includes(effort) ? effort : '';
  return effortToRun(provider, model, remembered || configured);
}

function pick(choice: ModelChoice): void {
  setAskCodeProvider(choice.provider);
  if (choice.model) setAskCodeModel(choice.model);
}

/** Shared model choices and preference for tours, code questions, and new reviewers. */
export function AgentModelMenu(props: {
  style?: JSX.CSSProperties;
  class?: string;
  label?: string;
  /** Show the chosen model on the trigger instead of a bare chevron. */
  showModel?: boolean;
  /** Offer the provider's reasoning levels below the models, remembered per provider. */
  showEffort?: boolean;
  disabled?: boolean;
  providers?: AskCodeProvider[];
  provider?: AskCodeProvider;
  /** What the launch's own args set, shown where the app has no choice of its own. */
  configured?: { model: string; effort: string };
  onSelect?: (provider: AskCodeProvider) => void;
}) {
  const availableGroups = () =>
    // By provider, so Codex keeps its group while its models are still loading.
    groups().filter((group) => !props.providers || props.providers.includes(group.provider));
  const choices = () => availableGroups().flatMap((group) => group.choices);
  const provider = () => props.provider ?? store.askCodeProvider;
  const model = () =>
    modelToRun(
      provider(),
      (provider() === store.askCodeProvider
        ? store.askCodeModel
        : defaultAskCodeModel(provider())) ||
        (props.configured?.model ?? ''),
    );
  const key = (choice: ModelChoice) => `${choice.provider}:${choice.model ?? ''}`;
  const modelText = () =>
    choices().find((choice) => choice.provider === provider() && choice.model === model())?.label ||
    model() ||
    askCodeLabel(provider(), '');
  const efforts = () => (props.showEffort ? effortChoices(provider(), model()) : []);
  const effort = () =>
    props.showEffort ? chosenEffort(provider(), model(), props.configured?.effort) : '';
  const effortText = () => (effort() ? ` · ${reasoningEffortLabel(effort())}` : '');
  return (
    <ModelMenu
      {...props}
      label={props.label ?? 'Model'}
      text={props.showModel ? `${modelText()}${effortText()}` : undefined}
      title={`Model: ${askCodeLabel(provider(), model())}${effortText()}`}
      value={`${provider()}:${model()}`}
      groups={availableGroups().map((group) => ({
        ...group,
        choices: group.choices.map((choice) => ({ ...choice, value: key(choice) })),
      }))}
      section={
        efforts().length > 0
          ? {
              heading: 'Reasoning',
              choices: efforts().map((value) => ({ value, label: reasoningEffortLabel(value) })),
              value: effort(),
              onSelect: (value) => setAskCodeEffort(provider(), value),
            }
          : undefined
      }
      onOpen={loadCodexModels}
      onSelect={(value) => {
        const choice = choices().find((choice) => key(choice) === value);
        if (choice) {
          pick(choice);
          props.onSelect?.(choice.provider);
        }
      }}
    />
  );
}

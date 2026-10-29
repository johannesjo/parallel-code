import { For, Show, createEffect } from 'solid-js';
import {
  ASK_CODE_CLAUDE_MODELS,
  type AskCodeProvider,
} from '../../../electron/shared/ask-code-models';
import { codexModels, loadCodexModels } from '../../lib/codex-models';
import {
  BRIEF_MODELS,
  TASK_NAME_MODELS,
  type BriefModelId,
  type TaskNameModelId,
} from '../../../electron/shared/task-name-model';
import { theme } from '../../lib/theme';
import type { BriefBarFields } from '../../lib/task-brief';
import {
  store,
  setModelTaskNames,
  setTaskNameModel,
  setTaskBriefs,
  setBriefBarField,
  setBriefModel,
  setFinishReview,
  setReviewGuidance,
  setReviewModel,
  setAskCodeProvider,
  setAskCodeModel,
  setMinimaxApiKey,
} from '../../store/store';
import { modelToRun } from '../../lib/ask-code-model';
import { withReviewEffort } from '../../lib/task-review';
import { ReviewModelFields } from '../ReviewModelFields';
import {
  SettingsCard,
  SettingsCheckboxRow,
  SettingsSection,
  settingsFieldStyle,
} from './settings-ui';

/** What each code Q&A provider needs installed, for the row under the select. */
const ASK_CODE_PROVIDER_HINTS: Record<AskCodeProvider, string> = {
  claude:
    'Uses the claude CLI to answer questions about selected code. Requires Claude Code to be installed.',
  codex:
    'Uses the codex CLI (codex exec, read-only sandbox) to answer questions about selected code. Requires Codex to be installed.',
  minimax:
    'Uses MiniMax M2.7 (204K context) via the OpenAI-compatible API — no Claude Code CLI required.',
};

function ModelSelect(props: {
  label: string;
  value: string;
  choices: Record<string, { label: string }>;
  onChange: (id: string) => void;
}) {
  return (
    <SettingsCard>
      <label style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
        <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
          {props.label}
        </span>
        <select
          value={props.value}
          onChange={(e) => props.onChange(e.currentTarget.value)}
          style={{ flex: '1', ...settingsFieldStyle, 'font-size': '13px', cursor: 'pointer' }}
        >
          <For each={Object.entries(props.choices)}>
            {([id, choice]) => <option value={id}>{choice.label}</option>}
          </For>
        </select>
      </label>
    </SettingsCard>
  );
}

const BRIEF_BAR_FIELD_CHOICES: { field: keyof BriefBarFields; label: string }[] = [
  { field: 'goal', label: 'Goal' },
  { field: 'now', label: 'Now' },
  { field: 'needsYou', label: 'Needs you' },
];

export function AiAssistSettings() {
  // The Codex model select is filled from the CLI's cache, read on first need.
  createEffect(() => {
    if (store.askCodeProvider === 'codex') loadCodexModels();
  });

  return (
    <>
      <SettingsSection title="Task names & briefs">
        <SettingsCheckboxRow
          label="Name tasks with a model"
          checked={store.modelTaskNames}
          onChange={setModelTaskNames}
          description="Ask a cheap model for a short title when a task is named from its prompt; sends the prompt to that model's provider. With briefs on, the first brief sharpens the title once from what the agent did. The branch keeps its prompt-based name"
        />
        <SettingsCheckboxRow
          label="Write task briefs"
          checked={store.taskBriefs}
          onChange={setTaskBriefs}
          description="After each agent turn, a model sums up the goal, the current step and anything the agent needs from you. Sends the turn's prompts, the agent's last message and the diff to that model's provider"
        />
        <Show when={store.modelTaskNames}>
          <ModelSelect
            label="Naming model"
            value={store.taskNameModel}
            choices={TASK_NAME_MODELS}
            onChange={(id) => setTaskNameModel(id as TaskNameModelId)}
          />
        </Show>
        <Show when={store.taskBriefs}>
          <ModelSelect
            label="Briefs model"
            value={store.briefModel}
            choices={BRIEF_MODELS}
            onChange={(id) => setBriefModel(id as BriefModelId)}
          />
          <SettingsCard>
            <span style={{ 'font-size': '13px', color: theme.fg }}>Show in the task header</span>
            <span style={{ 'font-size': '12px', color: theme.fgMuted }}>
              Clicking the header line opens every field. A question takes the top line while the
              agent waits on you.
            </span>
            <div style={{ display: 'flex', gap: '16px', 'flex-wrap': 'wrap' }}>
              <For each={BRIEF_BAR_FIELD_CHOICES}>
                {(choice) => (
                  <label
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '6px',
                      'font-size': '13px',
                      color: theme.fg,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={store.briefBarFields[choice.field]}
                      onChange={(e) => setBriefBarField(choice.field, e.currentTarget.checked)}
                      style={{ 'accent-color': theme.accent, cursor: 'inherit' }}
                    />
                    {choice.label}
                  </label>
                )}
              </For>
            </div>
          </SettingsCard>
        </Show>
      </SettingsSection>
      <SettingsSection title="Review">
        <SettingsCheckboxRow
          label="Offer a review when finishing a task"
          checked={store.finishReview}
          onChange={setFinishReview}
          description="Adds a Review line to the Finish dialog. Nothing runs until you click Run review, which sends your prompts, the branch diff and the picked checks' results to a separate reviewer model that can read but not change the repository, so the task's agent never rates its own work"
        />
        <Show when={store.finishReview}>
          <SettingsCard>
            <div
              style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'flex-wrap': 'wrap' }}
            >
              <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
                Reviewer model
              </span>
              <ReviewModelFields
                value={withReviewEffort(store.reviewModel)}
                onChange={(change) => setReviewModel({ ...store.reviewModel, ...change })}
                style={{ ...settingsFieldStyle, 'font-size': '13px', cursor: 'pointer' }}
              />
            </div>
            <label style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
              <span style={{ 'font-size': '13px', color: theme.fg }}>Review guidance</span>
              <span style={{ 'font-size': '12px', color: theme.fgMuted }}>
                Optional notes added to the reviewer's instructions, such as what matters in your
                codebase.
              </span>
              <textarea
                rows={3}
                value={store.reviewGuidance}
                onChange={(e) => setReviewGuidance(e.currentTarget.value)}
                style={{
                  resize: 'vertical',
                  ...settingsFieldStyle,
                  'font-size': '12px',
                  'font-family': 'inherit',
                }}
              />
            </label>
          </SettingsCard>
        </Show>
      </SettingsSection>
      <SettingsSection title="Ask about code">
        <SettingsCard>
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
            }}
          >
            <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
              LLM provider
            </span>
            <select
              value={store.askCodeProvider}
              onChange={(e) => setAskCodeProvider(e.currentTarget.value as AskCodeProvider)}
              style={{
                flex: '1',
                ...settingsFieldStyle,
                'font-size': '13px',
                cursor: 'pointer',
              }}
            >
              <option value="claude">Claude Code (claude CLI)</option>
              <option value="codex">Codex (codex CLI)</option>
              <option value="minimax">MiniMax (M2.7)</option>
            </select>
          </label>
          <Show when={store.askCodeProvider !== 'minimax'}>
            <label style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
              <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
                Model
              </span>
              <select
                value={modelToRun(store.askCodeProvider, store.askCodeModel)}
                onChange={(e) => setAskCodeModel(e.currentTarget.value)}
                style={{
                  flex: '1',
                  ...settingsFieldStyle,
                  'font-size': '13px',
                  cursor: 'pointer',
                }}
              >
                <Show
                  when={store.askCodeProvider === 'codex'}
                  fallback={
                    <For each={ASK_CODE_CLAUDE_MODELS}>
                      {(model) => <option value={model}>{model}</option>}
                    </For>
                  }
                >
                  <For each={codexModels()}>
                    {(model) => <option value={model.slug}>{model.displayName}</option>}
                  </For>
                </Show>
              </select>
            </label>
          </Show>
          <Show when={store.askCodeProvider === 'minimax'}>
            <label
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '10px',
                'margin-top': '4px',
              }}
            >
              <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
                MiniMax API key
              </span>
              <input
                type="password"
                onInput={(e) => setMinimaxApiKey(e.currentTarget.value)}
                placeholder="Enter your MINIMAX_API_KEY (stored in memory only)"
                style={{
                  flex: '1',
                  ...settingsFieldStyle,
                  'font-size': '13px',
                  'font-family': "'JetBrains Mono', monospace",
                }}
              />
            </label>
          </Show>
          <span style={{ 'font-size': '11px', color: theme.fgSubtle }}>
            {ASK_CODE_PROVIDER_HINTS[store.askCodeProvider]}
          </span>
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

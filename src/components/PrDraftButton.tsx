import { Show } from 'solid-js';
import { BRIEF_MODELS } from '../../electron/shared/task-name-model';
import type { DraftSource, PrDrafting } from './create-pr-drafting';
import { ModelMenu } from './ModelMenu';
import { CloseIcon, PencilIcon } from './icons';

const MODEL_CHOICES = Object.entries(BRIEF_MODELS).map(([value, m]) => ({
  value,
  label: m.label,
}));

/**
 * "Draft description ▾": drafts with the picked source. The chevron picks the
 * task's agent or a separate model, or stops a running draft.
 */
export function PrDraftButton(props: {
  drafting: PrDrafting;
  hasBody: boolean;
  hasAgent: boolean;
  disabled: boolean;
}) {
  let action: HTMLButtonElement | undefined;
  const label = () => {
    if (props.drafting.drafting()) return 'Drafting…';
    return props.hasBody ? 'Draft again' : 'Draft description';
  };
  const actionTitle = () => {
    const from = props.drafting.source();
    return from === 'agent'
      ? `Asks ${props.drafting.agentName()} to draft the title and description in its session, then fills them in here`
      : `Drafts a title and description from the task's prompts, commits and diff with ${BRIEF_MODELS[from].label}`;
  };
  const groups = () => [
    ...(props.hasAgent
      ? [
          {
            heading: "This task's agent",
            choices: [
              {
                value: 'agent',
                label: props.drafting.agentName(),
                disabledReason: props.drafting.agentBlocker() ?? undefined,
              },
            ],
          },
        ]
      : []),
    { heading: 'Separate model', choices: MODEL_CHOICES },
  ];
  return (
    <div class="finish-followup" style={{ margin: '0', flex: 'none', width: 'auto' }}>
      <div class="change-tour-row">
        <button
          ref={action}
          type="button"
          class="change-tour-action"
          style={{ flex: 'none', width: 'auto' }}
          aria-busy={!!props.drafting.drafting()}
          disabled={props.disabled}
          title={actionTitle()}
          onClick={() => {
            if (!props.drafting.drafting()) props.drafting.start();
          }}
        >
          <Show when={props.drafting.drafting()} fallback={<PencilIcon size={14} />}>
            <span class="inline-spinner" aria-hidden="true" />
          </Show>
          <span class="change-tour-action-label">{label()}</span>
        </button>
        <Show
          when={props.drafting.drafting()}
          fallback={
            <ModelMenu
              class="change-tour-model"
              label="Draft with"
              title={`Draft with: ${props.drafting.sourceLabel(props.drafting.source())}`}
              disabled={props.disabled}
              value={props.drafting.source()}
              groups={groups()}
              onSelect={(value) => props.drafting.pick(value as DraftSource)}
            />
          }
        >
          {(from) => (
            <button
              type="button"
              class="change-tour-model"
              aria-label={from() === 'agent' ? 'Stop waiting for the agent' : 'Stop drafting'}
              title={from() === 'agent' ? 'Stop waiting for the agent' : 'Stop drafting'}
              onClick={() => {
                action?.focus();
                props.drafting.stop();
              }}
            >
              <CloseIcon size={12} />
            </button>
          )}
        </Show>
      </div>
    </div>
  );
}

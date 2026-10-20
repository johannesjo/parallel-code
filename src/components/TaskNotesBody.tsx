import { Show, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import {
  store,
  updateTaskNotes,
  setTaskFocusedPanel,
  sendPrompt,
  isAgentAskingQuestion,
  isPanelFocused,
} from '../store/store';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { useFocusRegistration } from '../lib/focus-registration';
import { UnderstandButton } from './understanding/UnderstandButton';
import { HoverHint } from './understanding/HoverHint';
import {
  planTourSubject,
  type UnderstandingTourController,
} from '../lib/create-understanding-tour';
import type { Task } from '../store/types';

interface TaskNotesBodyProps {
  task: Task;
  agentId: string;
  onPlanFullscreen: () => void;
  understanding: UnderstandingTourController;
  onPlanTour: () => void;
  /** Opens the tour the agent published for this task, if there is one. */
  onAgentTour?: () => void;
}

/** Inset of the send button from the notes panel's bottom-right corner. */
const OVERLAY_INSET = '6px';

const sendButtonStyle: JSX.CSSProperties = {
  position: 'absolute',
  bottom: OVERLAY_INSET,
  right: OVERLAY_INSET,
  'z-index': '1',
};

/** What the footer bar adds: `.change-tour-action` min-height plus its border-top. */
const TOUR_FOOTER_HEIGHT = 31;

export function TaskNotesBody(props: TaskNotesBodyProps) {
  const [sendingNotes, setSendingNotes] = createSignal(false);

  async function handleSendNotes() {
    if (sendingNotes()) return;
    const val = props.task.notes?.trim();
    if (!val) return;
    if (!props.agentId) return;
    if (isAgentAskingQuestion(props.agentId)) return;
    setSendingNotes(true);
    try {
      await sendPrompt(props.task.id, props.agentId, val);
    } catch (e) {
      console.error('Failed to send notes to prompt:', e);
    } finally {
      setSendingNotes(false);
    }
  }

  const canSendNotes = () =>
    !sendingNotes() &&
    !!props.task.notes?.trim() &&
    !!props.agentId &&
    !isAgentAskingQuestion(props.agentId);
  let notesRef: HTMLTextAreaElement | undefined;
  onMount(() => {
    useFocusRegistration(`${props.task.id}:notes`, () => notesRef?.focus());
  });

  // Keep empty notes compact; plans open in the viewer from the button.
  const isEmpty = () => !props.task.notes?.trim();
  const showPlanActions = () => !!(store.showPlans && props.task.planContent);
  /** Worktree-relative, so the hint shows which of the plan folders it came from. */
  const planFile = () => props.task.planPath ?? props.task.planFileName ?? 'plan.md';
  const showTourFooter = () => showPlanActions() || !!props.task.agentTour;
  const intrinsicHeight = () => {
    const editor = isEmpty() ? 56 : store.focusMode ? 240 : 140;
    return `${editor + (showTourFooter() ? TOUR_FOOTER_HEIGHT : 0)}px`;
  };

  return (
    <div
      class="task-notes-body focusable-panel"
      data-empty={isEmpty()}
      data-panel-focused={isPanelFocused(props.task.id, 'notes') ? 'true' : 'false'}
      style={{
        width: '100%',
        height: '100%',
        'min-height': intrinsicHeight(),
        display: 'flex',
        'flex-direction': 'column',
      }}
      onClick={() => setTaskFocusedPanel(props.task.id, 'notes')}
    >
      <div
        style={{
          flex: '1',
          display: 'flex',
          'flex-direction': 'column',
          position: 'relative',
          'min-height': '0',
        }}
      >
        <textarea
          ref={(el) => (notesRef = el)}
          value={props.task.notes}
          onInput={(e) => updateTaskNotes(props.task.id, e.currentTarget.value)}
          aria-label="Task notes"
          placeholder="Add a note…"
          style={{
            width: '100%',
            flex: '1',
            background: theme.taskPanelBg,
            border: 'none',
            padding: '6px 8px',
            color: theme.fg,
            'font-size': sf(12),
            'font-family': "'JetBrains Mono', monospace",
            resize: 'none',
            outline: 'none',
          }}
        />
        <div style={sendButtonStyle}>
          <button
            class="send-notes-btn"
            type="button"
            disabled={!canSendNotes()}
            onClick={() => void handleSendNotes()}
            title="Send notes as a prompt to the agent"
            aria-label="Send notes as a prompt to the agent"
            style={{
              width: '22px',
              height: '22px',
              padding: '0',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              background: `color-mix(in srgb, ${theme.accent} 12%, ${theme.bgInput})`,
              color: theme.fg,
              border: `1px solid color-mix(in srgb, ${theme.accent} 25%, ${theme.border})`,
              'border-radius': '50%',
              cursor: canSendNotes() ? 'pointer' : 'default',
              opacity: canSendNotes() ? '1' : '0.4',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path
                d="M7 2V12M7 12L3 8M7 12l4 -4"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      {/* The same flat bar the Changed Files panel uses for its Change Tour, so
          these actions sit beside the note instead of covering the text in it. */}
      <Show when={showTourFooter()}>
        <div class="change-tour-footer notes-tour-footer">
          <div class="change-tour-row">
            <Show when={showPlanActions()}>
              {/* Which file the app settled on is not obvious from the button, and
                  a worktree can hold several candidates; the hint names it. */}
              <HoverHint
                hint={() => (
                  <>
                    <strong class="tour-hint-heading">Plan for this task</strong>
                    <code class="tour-hint-subject" title={planFile()}>
                      {planFile()}
                    </code>
                    <p class="tour-hint-body">
                      Detected automatically: the most recently changed plan file in this worktree.
                      Writing a newer one replaces it here.
                    </p>
                    <p class="tour-hint-action">Click to open it.</p>
                  </>
                )}
              >
                {(describedBy) => (
                  <button
                    type="button"
                    class="change-tour-action"
                    aria-haspopup="dialog"
                    aria-describedby={describedBy()}
                    onClick={() => props.onPlanFullscreen()}
                  >
                    <span class="change-tour-action-label">Review Plan</span>
                  </button>
                )}
              </HoverHint>
              <UnderstandButton
                label="Take Tour"
                tour={props.understanding}
                kind="plan"
                subject={planTourSubject(props.task)}
                onClick={() => props.onPlanTour()}
                modelMenu
              />
            </Show>
            {/* The agent publishes a tour on request; the button keeps it reachable
                after the viewer is closed. */}
            <Show when={props.task.agentTour}>
              {(agentTour) => (
                <UnderstandButton
                  label="Agent Tour"
                  tour={props.understanding}
                  kind="agent"
                  subject={agentTour().payload.subject}
                  onClick={() => props.onAgentTour?.()}
                />
              )}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

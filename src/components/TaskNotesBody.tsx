import { Show, createSignal, createEffect, onMount } from 'solid-js';
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
import { createHighlightedMarkdown } from '../lib/marked-shiki';
import { useFocusRegistration } from '../lib/focus-registration';
import type { Task } from '../store/types';

interface TaskNotesBodyProps {
  task: Task;
  agentId: string;
  onPlanFullscreen: () => void;
}

export function TaskNotesBody(props: TaskNotesBodyProps) {
  const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');
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
  const planHtml = createHighlightedMarkdown(() => props.task.planContent);

  // Auto-switch to plan tab when plan content first appears
  let hadPlan = false;
  createEffect(() => {
    const hasPlan = store.showPlans && !!props.task.planContent;
    if (hasPlan && !hadPlan) {
      setNotesTab('plan');
    } else if (!hasPlan && hadPlan) {
      setNotesTab('notes');
    }
    hadPlan = hasPlan;
  });

  let notesRef: HTMLTextAreaElement | undefined;
  let planScrollRef: HTMLDivElement | undefined;

  onMount(() => {
    const id = props.task.id;
    useFocusRegistration(`${id}:notes`, () => {
      if (notesTab() === 'plan') {
        planScrollRef?.focus();
      } else {
        notesRef?.focus();
      }
    });
  });

  // An empty notes box shouldn't claim a third of the column: stay a thin
  // strip until there is text or a plan to show.
  const isEmpty = () => !props.task.notes?.trim() && !(store.showPlans && props.task.planContent);
  const intrinsicHeight = () => (isEmpty() ? '56px' : store.focusMode ? '240px' : '140px');

  return (
    <div
      class="focusable-panel"
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
      <Show when={store.showPlans && props.task.planContent}>
        <div
          style={{
            display: 'flex',
            'border-bottom': `1px solid ${theme.border}`,
            'flex-shrink': '0',
          }}
        >
          <button
            style={{
              padding: '2px 8px',
              'font-size': sf(11),
              background: notesTab() === 'notes' ? theme.taskPanelBg : 'transparent',
              color: notesTab() === 'notes' ? theme.fg : theme.fgMuted,
              border: 'none',
              'border-bottom':
                notesTab() === 'notes' ? `2px solid ${theme.accent}` : '2px solid transparent',
              cursor: 'pointer',
              'font-family': "'JetBrains Mono', monospace",
            }}
            onClick={() => setNotesTab('notes')}
          >
            Notes
          </button>
          <button
            style={{
              padding: '2px 8px',
              'font-size': sf(11),
              background: notesTab() === 'plan' ? theme.taskPanelBg : 'transparent',
              color: notesTab() === 'plan' ? theme.fg : theme.fgMuted,
              border: 'none',
              'border-bottom':
                notesTab() === 'plan' ? `2px solid ${theme.accent}` : '2px solid transparent',
              cursor: 'pointer',
              'font-family': "'JetBrains Mono', monospace",
            }}
            onClick={() => setNotesTab('plan')}
          >
            Plan
          </button>
        </div>
      </Show>

      <Show when={notesTab() === 'notes' || !store.showPlans || !props.task.planContent}>
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
            placeholder="Notes..."
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
          <button
            class="send-notes-btn"
            type="button"
            disabled={!canSendNotes()}
            onClick={() => void handleSendNotes()}
            title="Send notes as a prompt to the agent"
            aria-label="Send notes as a prompt to the agent"
            style={{
              position: 'absolute',
              bottom: '6px',
              right: '6px',
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
              'z-index': '1',
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
      </Show>

      <Show when={notesTab() === 'plan' && store.showPlans && props.task.planContent}>
        <div
          style={{
            flex: '1',
            overflow: 'hidden',
            display: 'flex',
            'flex-direction': 'column',
            position: 'relative',
          }}
        >
          <div
            ref={(el) => (planScrollRef = el)}
            tabIndex={0}
            class="plan-markdown"
            style={{
              flex: '1',
              overflow: 'auto',
              padding: '6px 8px',
              background: theme.taskPanelBg,
              color: theme.fg,
              'font-size': sf(12),
              'font-family': "'JetBrains Mono', monospace",
              outline: 'none',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                props.onPlanFullscreen();
                return;
              }
              if (!planScrollRef) return;
              const step = 40;
              const page = Math.max(100, planScrollRef.clientHeight - 40);
              switch (e.key) {
                case 'ArrowDown':
                  e.preventDefault();
                  planScrollRef.scrollTop += step;
                  break;
                case 'ArrowUp':
                  e.preventDefault();
                  planScrollRef.scrollTop -= step;
                  break;
                case 'PageDown':
                  e.preventDefault();
                  planScrollRef.scrollTop += page;
                  break;
                case 'PageUp':
                  e.preventDefault();
                  planScrollRef.scrollTop -= page;
                  break;
                case 'Home':
                  e.preventDefault();
                  planScrollRef.scrollTop = 0;
                  break;
                case 'End':
                  e.preventDefault();
                  planScrollRef.scrollTop = planScrollRef.scrollHeight;
                  break;
              }
            }}
            // eslint-disable-next-line solid/no-innerhtml -- plan files are local, written by Claude Code in the worktree
            innerHTML={planHtml()}
          />
          <button
            class="btn-secondary review-plan-btn"
            style={{
              position: 'absolute',
              bottom: '8px',
              right: '8px',
              padding: '4px 16px',
              'font-size': sf(12),
              'font-family': "'JetBrains Mono', monospace",
              background: `color-mix(in srgb, ${theme.accent} 12%, ${theme.bgInput})`,
              color: theme.fg,
              border: `1px solid color-mix(in srgb, ${theme.accent} 25%, ${theme.border})`,
              'border-radius': 'var(--radius-sm)',
              cursor: 'pointer',
              'z-index': '1',
            }}
            onClick={() => props.onPlanFullscreen()}
          >
            Review Plan
          </button>
        </div>
      </Show>
    </div>
  );
}

import { Show, createSignal } from 'solid-js';
import { errMessage } from '../lib/log';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';
import { store } from '../store/core';
import { showNotification } from '../store/notification';
import { babysitAgentBlocker } from '../store/pr-babysit';
import { sendPrompt } from '../store/tasks';
import type { Task } from '../store/types';
import { IdeaIcon } from './icons';

const RETRO_STEPS = `1. Look back at where you or I lost time: failed or repeated commands, wrong assumptions, missing or misleading instructions, slow or flaky checks, permission prompts, and manual steps that could be scripted.
2. For each real problem, propose one concrete change to our tooling, such as project instructions (AGENTS.md, CLAUDE.md), agent settings or hooks, skills or commands, scripts, tests, or checks. Name the file and show the exact edit.
3. Rank the proposals by the time they would save. Skip one-off problems that are unlikely to recur.`;

const RETRO_END = `Apply nothing yet; I will tell you which proposals to apply. If the session went smoothly, say so in one line instead of inventing problems.`;

/** Built in rather than a skill, so it works for every agent and every user. */
export const RETRO_PROMPT = `Run a short retrospective on this session before the task is merged.

${RETRO_STEPS}

${RETRO_END}`;

/**
 * The retro for a task about to be closed unmerged. Edits applied in a worktree
 * that close deletes would vanish with it, so the agent is told where they go.
 */
export function closeRetroPrompt(deletesWorktree: boolean): string {
  const target = deletesWorktree
    ? `\n\nThis task's worktree will be deleted when it closes, so edits made in it would be lost. When I ask you to apply a change to project files, make it in the main checkout instead, or print them for me to carry over; files outside this worktree, such as global agent instructions, can be edited directly.`
    : '';
  return `Run a short retrospective on this session before the task is closed.

${RETRO_STEPS}${target}

${RETRO_END}`;
}

/**
 * Finish and Close step that asks the task's main agent for a retrospective.
 * The prompt goes to a live session the user may be using, so a click first
 * says where it goes and holds the send while the agent is busy or input is unsent.
 */
export function RetroButton(props: { task: Task; prompt?: string; onSent: () => void }) {
  const [confirming, setConfirming] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const agentId = () => props.task.agentIds[0];
  const agentName = () => {
    const id = agentId();
    return (id && store.agents[id]?.def?.name) || 'the agent';
  };
  const blocker = () => babysitAgentBlocker(props.task.id);
  let retroRef: HTMLButtonElement | undefined;
  let cancelRef: HTMLButtonElement | undefined;
  // Show swaps the clicked button out, so focus moves along instead of dropping to the body.
  const toggle = (open: boolean) => {
    setConfirming(open);
    (open ? cancelRef : retroRef)?.focus();
  };

  const send = async () => {
    const id = agentId();
    if (!id || blocker()) return;
    setSending(true);
    try {
      await sendPrompt(props.task.id, id, props.prompt ?? RETRO_PROMPT, {
        appPrompt: true,
      });
      showNotification(`Retro sent to ${agentName()}.`);
      props.onSent();
    } catch (err) {
      showNotification(`Could not send the retro: ${errMessage(err)}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <Show
      when={confirming()}
      fallback={
        <div class="finish-followup finish-followup-quiet">
          <div class="change-tour-row">
            <button
              ref={retroRef}
              type="button"
              class="change-tour-action"
              title={`Ask ${agentName()} what would have made this session smoother`}
              onClick={() => toggle(true)}
            >
              <IdeaIcon size={14} />
              <span class="change-tour-action-label">Retro</span>
            </button>
          </div>
        </div>
      }
    >
      <div
        class="finish-followup"
        style={{ 'flex-basis': '100%', padding: '10px 14px', 'font-size': sf(13) }}
      >
        <p style={{ margin: '0 0 4px' }}>
          Sends a retrospective prompt to {agentName()}, this task's main agent. It proposes changes
          to instructions, settings, and scripts, and applies nothing until you ask.
        </p>
        {/* Space stays reserved so the buttons do not move as the agent goes busy and idle. */}
        <p
          role="status"
          style={{
            margin: '0 0 8px',
            'min-height': '1.45em',
            color: theme.warning,
            visibility: blocker() ? 'visible' : 'hidden',
          }}
        >
          {blocker() ? `Can't send yet: ${blocker()}.` : ''}
        </p>
        <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
          <button
            ref={cancelRef}
            type="button"
            class="btn-secondary"
            disabled={sending()}
            onClick={() => toggle(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            disabled={!!blocker() || sending()}
            aria-busy={sending()}
            onClick={() => void send()}
          >
            Send to {agentName()}
          </button>
        </div>
      </div>
    </Show>
  );
}

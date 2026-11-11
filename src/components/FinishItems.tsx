import { For, Show, createSignal } from 'solid-js';
import { errMessage } from '../lib/log';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';
import { store } from '../store/core';
import { sendFinishItems } from '../store/finish-items';
import { showNotification } from '../store/notification';
import { babysitAgentBlocker } from '../store/pr-babysit';
import type { Task } from '../store/types';

/**
 * Finish step listing the loose ends the task's agent recorded, such as a flag
 * to remove, and sending the ones the user keeps back to it. Items show in full
 * because their text came from the agent's session and goes back as a prompt.
 */
export function FinishItems(props: { task: Task; onSent: () => void }) {
  // Unticked by text, so a republished list keeps the user's choices for items it repeats.
  const [skipped, setSkipped] = createSignal<ReadonlySet<string>>(new Set());
  const [sending, setSending] = createSignal(false);
  const items = () => props.task.finishItems?.items ?? [];
  const kept = () => items().filter((item) => !skipped().has(item));
  const agentName = () => {
    const id = props.task.agentIds[0];
    return (id && store.agents[id]?.def?.name) || 'the agent';
  };
  const blocker = () => babysitAgentBlocker(props.task.id);
  const toggle = (item: string, keep: boolean) => {
    const next = new Set(skipped());
    if (keep) next.delete(item);
    else next.add(item);
    setSkipped(next);
  };

  const send = async () => {
    const chosen = kept();
    if (!chosen.length || blocker()) return;
    setSending(true);
    try {
      await sendFinishItems(props.task.id, chosen);
      showNotification(`Loose ends sent to ${agentName()}. Finish again once it is done.`);
      props.onSent();
    } catch (err) {
      showNotification(`Could not send the loose ends: ${errMessage(err)}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <Show when={items().length}>
      <div class="finish-followup" style={{ padding: '10px 14px', 'font-size': sf(13) }}>
        <p style={{ margin: '0 0 6px' }}>Loose ends {agentName()} noted for before merge:</p>
        <ul style={{ margin: '0 0 4px', padding: '0', 'list-style': 'none' }}>
          <For each={items()}>
            {(item) => (
              <li>
                <label style={{ display: 'flex', gap: '6px', 'align-items': 'baseline' }}>
                  <input
                    type="checkbox"
                    checked={!skipped().has(item)}
                    onChange={(e) => toggle(item, e.currentTarget.checked)}
                  />
                  <span style={{ 'overflow-wrap': 'anywhere' }}>{item}</span>
                </label>
              </li>
            )}
          </For>
        </ul>
        {/* Space stays reserved so the button does not move as the agent goes busy and idle. */}
        <p
          role="status"
          style={{
            margin: '0 0 8px',
            'min-height': '1.45em',
            color: blocker() ? theme.warning : theme.fgMuted,
          }}
        >
          {blocker()
            ? `Can't send yet: ${blocker()}.`
            : props.task.finishItems?.sentAt
              ? `Sent to ${agentName()}; it clears the list once done.`
              : ''}
        </p>
        <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
          <button
            type="button"
            class="btn-primary"
            disabled={!!blocker() || sending() || !kept().length}
            aria-busy={sending()}
            onClick={() => void send()}
          >
            {props.task.finishItems?.sentAt ? 'Send again' : `Send to ${agentName()}`}
          </button>
        </div>
      </div>
    </Show>
  );
}

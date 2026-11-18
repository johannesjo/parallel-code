import { Show, createSignal } from 'solid-js';
import {
  implementPlanInFreshSession,
  planningSessionToReturnTo,
  returnToPlanningBlocker,
  returnToPlanningSession,
  taskPlanHandoffBlocker,
} from '../store/plan-handoff';
import { NOTIFICATION_ERROR_MS, showNotification } from '../store/notification';
import { confirm } from '../lib/dialog';
import { errMessage } from '../lib/log';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

const IMPLEMENT_HINT =
  'Restart the agent with a clean context and send it this plan. ' +
  'The planning conversation stays in the session history.';

/** Plan viewer actions that hand the approved plan to a fresh session, and
 *  take the pane back to the planning session afterwards. */
export function PlanHandoffActions(props: { taskId: string; onHandedOff: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const blocker = () => taskPlanHandoffBlocker(props.taskId);
  const planningSession = () => planningSessionToReturnTo(props.taskId);
  const backBlocker = () => returnToPlanningBlocker(props.taskId);

  async function implement() {
    setBusy(true);
    try {
      const refused = await implementPlanInFreshSession(props.taskId);
      if (refused) {
        showNotification(refused, { durationMs: NOTIFICATION_ERROR_MS });
        return;
      }
      props.onHandedOff();
      // The viewer is gone; the notice is the quickest way back. Clicking it is
      // the undo, so it doesn't ask again. The longer error duration leaves time to click.
      showNotification('Plan sent to a fresh session.', {
        durationMs: NOTIFICATION_ERROR_MS,
        action: { label: 'Back to planning', run: returnNow },
      });
    } catch (err) {
      showNotification(`Could not hand over the plan: ${errMessage(err)}`, {
        durationMs: NOTIFICATION_ERROR_MS,
      });
    } finally {
      setBusy(false);
    }
  }

  async function goBack() {
    const ok = await confirm(
      'This stops the session running now and reopens the planning conversation. ' +
        'The stopped session stays in the session history.',
      { title: 'Back to planning session', okLabel: 'Go back' },
    );
    if (ok && returnNow()) props.onHandedOff();
  }

  /** Goes back, or says why not; true once the pane is restarting. */
  function returnNow(): boolean {
    const refused = returnToPlanningSession(props.taskId);
    if (refused) showNotification(refused, { durationMs: NOTIFICATION_ERROR_MS });
    return !refused;
  }

  const buttonStyle = {
    background: 'transparent',
    border: `1px solid ${theme.border}`,
    cursor: 'pointer',
    padding: '3px 8px',
    'font-size': sf(11),
    'border-radius': 'var(--radius-xs)',
  };

  return (
    <>
      <Show when={planningSession()}>
        <button
          type="button"
          class="plan-back-to-planning-btn"
          onClick={() => void goBack()}
          disabled={!!backBlocker()}
          style={{
            ...buttonStyle,
            border: 'none',
            color: theme.fgMuted,
            cursor: backBlocker() ? 'default' : 'pointer',
          }}
          title={backBlocker() ?? 'Reopen the conversation this plan was made in'}
        >
          Back to planning session
        </button>
      </Show>
      <button
        type="button"
        class="plan-implement-fresh-btn"
        onClick={() => void implement()}
        disabled={busy() || !!blocker()}
        style={{
          ...buttonStyle,
          color: blocker() ? theme.fgMuted : theme.fg,
          cursor: blocker() ? 'default' : 'pointer',
        }}
        title={blocker() ?? IMPLEMENT_HINT}
      >
        Implement in fresh session
      </button>
    </>
  );
}

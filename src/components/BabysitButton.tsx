import { createSignal } from 'solid-js';
import { errMessage } from '../lib/log';
import { MAX_BABYSIT_ATTEMPTS } from '../lib/pr-babysit';
import { showNotification } from '../store/store';
import {
  babysitAgentBlocker,
  getPrBabysit,
  prBabysitStatus,
  startPrBabysit,
  stopPrBabysit,
} from '../store/pr-babysit';
import { EyeIcon } from './icons';

/** Toggles automatic hand-off of the PR's CI failures to the task's agent.
 *  `class` sets the look, so board cards can show it as one of their chips. */
export function BabysitButton(props: { taskId: string; class?: string }) {
  const [busy, setBusy] = createSignal(false);
  const on = () => getPrBabysit(props.taskId) !== undefined;
  const title = () => {
    const attempts = getPrBabysit(props.taskId)?.attempts ?? 0;
    return on()
      ? `Babysitting: CI failures go to the agent automatically (${attempts}/${MAX_BABYSIT_ATTEMPTS} fix attempts used). ${prBabysitStatus(props.taskId) ?? ''}. Click to stop.`
      : 'Send CI failures to the agent automatically until the checks pass';
  };
  const toggle = async () => {
    if (on()) {
      stopPrBabysit(props.taskId);
      return;
    }
    setBusy(true);
    try {
      if (await startPrBabysit(props.taskId)) {
        // A busy agent frees up by itself; other holds need the user, so name them now.
        const blocker = babysitAgentBlocker(props.taskId);
        showNotification(
          blocker && blocker !== 'The agent is busy'
            ? `Babysitting, but failures wait until this clears: ${blocker}.`
            : 'Babysitting: CI failures will go to the agent automatically.',
        );
      }
    } catch (err) {
      showNotification(`Could not start babysitting: ${errMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      class={`${props.class ?? 'task-pr-merge'} task-pr-babysit`}
      aria-pressed={on()}
      aria-busy={busy()}
      disabled={busy()}
      onClick={() => void toggle()}
      title={title()}
    >
      <EyeIcon size={12} />
      Babysit
    </button>
  );
}

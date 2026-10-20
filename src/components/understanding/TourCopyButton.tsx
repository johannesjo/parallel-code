import { Show, createSignal, onCleanup } from 'solid-js';
import { CheckIcon, CopyIcon } from '../icons';
import { TourIconButton } from './TourIconButton';
import { errMessage, warn as logWarn } from '../../lib/log';

/** How long the check mark confirms a copy before the icon resets. */
const CONFIRM_MS = 1500;

/** Copies the tour as Markdown, for a PR description, review comment or notes. */
export function TourCopyButton(props: { markdown: () => string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.markdown());
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), CONFIRM_MS);
    } catch (error) {
      logWarn('tour', 'Could not copy the tour', { error: errMessage(error) });
    }
  }

  return (
    <TourIconButton
      label={copied() ? 'Tour copied' : 'Copy tour as Markdown'}
      onClick={() => void copy()}
    >
      <Show when={copied()} fallback={<CopyIcon size={14} />}>
        <CheckIcon />
      </Show>
    </TourIconButton>
  );
}

import { Show } from 'solid-js';
import type { RemoteTaskPr } from '../../electron/remote/protocol';

/** The number in `…/pull/123`, or null for a URL that does not name one. */
function prNumber(url: string): string | null {
  return /\/pull\/(\d+)/.exec(url)?.[1] ?? null;
}

/**
 * The board card's PR row: the pull request, what its checks say, and whether
 * the desktop is babysitting it. Babysitting is switched on the computer; the
 * phone only shows it. Plain text because it sits inside the card's button.
 */
export function TaskPr(props: { pr: RemoteTaskPr }) {
  const number = () => prNumber(props.pr.url);
  return (
    <p class={`agent-pr ${props.pr.kind ?? ''}`}>
      <span class="agent-pr-chip">{number() ? `PR #${number()}` : 'PR'}</span>
      <Show when={props.pr.label}>{(label) => <span class="agent-pr-label">{label()}</span>}</Show>
      <Show when={props.pr.babysit}>
        <span class="agent-pr-babysit">Babysitting</span>
      </Show>
    </p>
  );
}

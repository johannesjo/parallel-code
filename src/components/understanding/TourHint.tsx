import { Show, type JSX } from 'solid-js';
import type { UnderstandingTourState } from '../../lib/create-understanding-tour';
import type { UnderstandingTourKind } from '../../lib/understanding-tour';
import { HoverHint } from './HoverHint';
import { askCodeModelLabel } from './ask-code-label';

const HEADINGS: Record<UnderstandingTourKind, string> = {
  plan: 'Guided tour of this plan',
  file: 'Guided tour of this file',
  document: 'Guided tour of this document',
  agent: 'Tour from the agent',
};

/** What an idle button's tour will cover; agent tours are written, not generated. */
const IDLE_BODIES: Record<Exclude<UnderstandingTourKind, 'agent'>, string> = {
  plan: 'A handful of cards on what this plan proposes: the gist, the key decisions, what it leaves for you to decide, and its risks. About a minute of reading.',
  document:
    'A handful of cards on what this document is, what it claims or decides, and what it asks of you. About a minute of reading.',
  file: 'A handful of cards on what this file is, how it works and what to watch out for. It reads the file and its direct imports.',
};

export interface TourHintText {
  heading: string;
  body: string;
  action: string;
}

/** What pressing the button does right now, for a reader who has never taken a tour. */
export function tourHintText(input: {
  kind: UnderstandingTourKind;
  subject: string;
  loading: boolean;
  ready: boolean;
  error: string;
  receiving: boolean;
  elapsedSeconds: number;
}): TourHintText {
  const heading = HEADINGS[input.kind];
  if (input.loading)
    return {
      heading,
      body: `Generating… ${input.receiving ? 'Receiving response' : 'Waiting for provider'} · ${input.elapsedSeconds}s`,
      action: 'Click to cancel.',
    };
  if (input.ready) return { heading, body: 'The tour is ready.', action: 'Click to open it.' };
  if (input.error) return { heading, body: input.error, action: 'Click to retry.' };
  if (input.kind === 'agent')
    return {
      heading,
      body: `Cards the agent wrote to explain ${input.subject}.`,
      action: 'Click to open it.',
    };
  return {
    heading,
    body: IDLE_BODIES[input.kind],
    action: 'Generates in the background; a notification tells you when it is ready.',
  };
}

/**
 * Hover and focus popover for a tour button: names the file the tour is about
 * and what the button does in its current state. Wraps the control; the child
 * renders the button and gives it `aria-describedby={describedBy()}`.
 */
export function TourHint(props: {
  kind: UnderstandingTourKind;
  subject: string;
  tour?: UnderstandingTourState;
  /** Extra class on the wrapper, for callers that position the control through it. */
  class?: string;
  children: (describedBy: () => string | undefined) => JSX.Element;
}) {
  const text = () =>
    tourHintText({
      kind: props.kind,
      subject: props.subject,
      loading: props.tour?.isLoading(props.kind, props.subject) ?? false,
      ready: props.tour?.isReady(props.kind, props.subject) ?? false,
      error: props.tour?.errorFor?.(props.kind, props.subject) ?? '',
      receiving: props.tour?.receiving?.() ?? false,
      elapsedSeconds: props.tour?.elapsedSeconds?.() ?? 0,
    });
  const idle = () => text().action.startsWith('Generates');

  return (
    <HoverHint
      class={props.class}
      hint={() => (
        <>
          <strong class="tour-hint-heading">{text().heading}</strong>
          <code class="tour-hint-subject" title={props.subject}>
            {props.subject}
          </code>
          <p class="tour-hint-body">{text().body}</p>
          <p class="tour-hint-action">{text().action}</p>
          <Show when={idle()}>
            <p class="tour-hint-action">Uses: {askCodeModelLabel()}</p>
          </Show>
        </>
      )}
    >
      {props.children}
    </HoverHint>
  );
}

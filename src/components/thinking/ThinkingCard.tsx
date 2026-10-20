import { Show, onMount } from 'solid-js';
import { TOUR_CARD_LIMITS } from '../../../electron/shared/understanding-limits';
import { editableText, withText } from '../../lib/tour-tree-edit';
import type { TourCard as TourCardData } from '../../lib/understanding-tour';
import { TourCard } from '../understanding/TourCard';

/** Where Alt and an arrow go from the card on screen. */
export type ThinkingMove = 'left' | 'right' | 'up' | 'down';

/** What a key typed into the card asks the tour to do. */
export type ThinkingAction =
  | 'done'
  | 'sibling'
  | 'child'
  | 'outdent'
  | 'write'
  | 'map'
  | ThinkingMove;

const ALT_KEYS: Record<string, ThinkingAction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'write',
};

/** Alt keys act the same while typing and reading: the arrows move, Enter writes the card. */
export function altAction(event: KeyboardEvent): ThinkingAction | undefined {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  return ALT_KEYS[event.key];
}

/**
 * Keys that act on the tour while the reader types. Plain Enter in the title
 * goes to the text below it; everything else here leaves the field.
 */
function actionFor(event: KeyboardEvent): ThinkingAction | undefined {
  const mod = event.ctrlKey || event.metaKey;
  if (event.key === 'Escape') return 'done';
  const alt = altAction(event);
  if (alt) return alt;
  if (event.key === 'Tab' && !mod && !event.altKey) return event.shiftKey ? 'outdent' : 'child';
  if (!mod || event.altKey || event.shiftKey) return undefined;
  if (event.key === 'Enter') return 'sibling';
  return event.key.toLowerCase() === 'm' ? 'map' : undefined;
}

/**
 * One card of a tour the reader writes, as small as a generated one so each
 * stays one digestible idea. Reading shows it as any tour card; editing turns
 * its title and text into fields. Past the size a card holds, the text fades
 * and the hint offers a follow-up or Write card instead of a hard stop.
 */
export function ThinkingCard(props: {
  card: TourCardData;
  editing: boolean;
  /** The field editing starts in: the title of a new card, else the text. */
  focus: 'title' | 'body';
  onChange: (card: TourCardData) => void;
  onAction: (action: ThinkingAction) => void;
  onEdit: () => void;
}) {
  const text = () => editableText(props.card);
  const over = () => text().length > TOUR_CARD_LIMITS.body;

  return (
    <div class="thinking-card" data-over={over() ? '' : undefined}>
      <Show
        when={props.editing}
        fallback={
          <div class="thinking-card-read" onDblClick={() => props.onEdit()}>
            <Show
              when={props.card.title || text()}
              fallback={<p class="thinking-card-empty">Empty card · type to write</p>}
            >
              <TourCard card={props.card} />
            </Show>
          </div>
        }
      >
        <EditFields
          card={props.card}
          text={text()}
          focus={props.focus}
          onAction={props.onAction}
          onChange={props.onChange}
        />
      </Show>
      <p class="thinking-card-hint" aria-live="polite">
        {/* Always laid out so the card never grows when the hint appears. */}
        <span style={{ visibility: over() ? 'visible' : 'hidden' }}>
          Long card · Tab for a follow-up, or Alt+Enter to write it as one card
        </span>
      </p>
    </div>
  );
}

function EditFields(props: {
  card: TourCardData;
  text: string;
  focus: 'title' | 'body';
  onAction: (action: ThinkingAction) => void;
  onChange: (card: TourCardData) => void;
}) {
  let title: HTMLInputElement | undefined;
  let body: HTMLTextAreaElement | undefined;
  onMount(() => {
    const field = props.focus === 'title' ? title : body;
    field?.focus();
    // The caret goes to the end, where the reader left off.
    field?.setSelectionRange(field.value.length, field.value.length);
  });

  function onKey(event: KeyboardEvent, field: 'title' | 'body'): void {
    // Native, not delegated: the dialog's own Escape and arrow keys listen on
    // document and must not see keys typed here.
    event.stopPropagation();
    if (event.isComposing) return;
    if (
      field === 'title' &&
      event.key === 'Enter' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      body?.focus();
      return;
    }
    const action = actionFor(event);
    if (!action) return;
    event.preventDefault();
    props.onAction(action);
  }

  return (
    <article class="understanding-card thinking-card-edit">
      <input
        ref={(element) => (title = element)}
        class="thinking-card-title"
        aria-label="Card title"
        placeholder="Title: the one idea on this card"
        maxLength={TOUR_CARD_LIMITS.title}
        value={props.card.title}
        onInput={(event) => props.onChange({ ...props.card, title: event.currentTarget.value })}
        on:keydown={(event) => onKey(event, 'title')}
      />
      <textarea
        ref={(element) => (body = element)}
        class="thinking-card-body"
        aria-label="Card text"
        placeholder="A few short points. Tab adds a follow-up; Alt+Enter writes it for you."
        value={props.text}
        onInput={(event) => props.onChange(withText(props.card, event.currentTarget.value))}
        on:keydown={(event) => onKey(event, 'body')}
      />
    </article>
  );
}

import { For, Show, createEffect } from 'solid-js';
import { createHighlightedMarkdown } from '../../lib/marked-shiki';
import { renderMermaidIn } from '../../lib/mermaid';
import { theme } from '../../lib/theme';
import type { TourCard as TourCardData, TourRef, TourTone } from '../../lib/understanding-tour';

/** Tone colour per card; `neutral` and `mechanical` carry no accent. */
const TONE_COLOR: Record<TourTone, string> = {
  neutral: theme.border,
  important: theme.accent,
  risk: theme.warning,
  uncertainty: theme.warning,
  mechanical: theme.border,
};

const WARNED: readonly TourTone[] = ['risk', 'uncertainty'];

function refLabel(ref: TourRef): string {
  if (ref.line === undefined) return ref.filePath;
  return ref.endLine === undefined
    ? `${ref.filePath}:${ref.line}`
    : `${ref.filePath}:${ref.line}-${ref.endLine}`;
}

/** Marks a ref chip as a place in the codebase rather than a word. */
function FileGlyph() {
  return (
    <svg width="9" height="11" viewBox="0 0 9 11" aria-hidden="true">
      <path
        d="M1 0.5h4L8 3.5v7H1z"
        fill="none"
        stroke="currentColor"
        stroke-width="1"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/**
 * One tour card: label, title, optional evidence (diagram or comparison),
 * markdown body, source quote, why-it-matters, refs. `data-form` lets the stylesheet give a
 * takeaway, comparison or flow card its own shape.
 */
export function TourCard(props: {
  card: TourCardData;
  onOpenRef?: (ref: TourRef) => void;
  onAsk?: (question: string) => void;
  asking?: boolean;
  answeredQuestions?: string[];
  /** Sections the tour left out; the dialog passes them to the last card only. */
  omitted?: string[];
}) {
  const bodyHtml = createHighlightedMarkdown(() => props.card.body);
  const tone = () => props.card.tone;
  const warned = () => WARNED.includes(tone());
  const questions = () =>
    (props.card.questions ?? []).filter((question) => !props.answeredQuestions?.includes(question));
  let mermaidHost: HTMLDivElement | undefined;

  // The host is reused across cards, so the previous diagram's rendered SVG is
  // replaced by the new source before rendering. The source stays as the
  // element's text so a Mermaid failure leaves readable text, not a blank box.
  createEffect(() => {
    const diagram = props.card.diagram;
    const block = mermaidHost?.firstElementChild;
    if (!(block instanceof HTMLElement) || diagram?.kind !== 'mermaid') return;
    block.classList.remove('mermaid-rendered');
    block.textContent = diagram.source;
    renderMermaidIn(mermaidHost, 'understanding');
  });

  return (
    <article
      class="understanding-card"
      data-tone={tone()}
      data-form={props.card.form}
      aria-label={props.card.title}
      // Every tone reads at full contrast; a mechanical card's low priority
      // shows in its muted label and plain rule, not in dimmed prose.
      style={{ '--tour-tone': TONE_COLOR[tone()], color: theme.fg }}
    >
      <p
        class="understanding-card-label"
        style={{
          color: warned() ? theme.warning : tone() === 'important' ? theme.accent : theme.fgMuted,
        }}
      >
        {warned() ? '⚠ ' : ''}
        {props.card.label}
      </p>
      <h2 class="understanding-card-title">{props.card.title}</h2>
      <Show when={props.card.diagram}>
        {(diagram) => (
          <Show
            when={diagram().kind === 'mermaid'}
            fallback={<pre class="understanding-diagram">{diagram().source}</pre>}
          >
            <div ref={mermaidHost}>
              <div class="mermaid-block" data-mermaid={diagram().source} />
            </div>
          </Show>
        )}
      </Show>
      <Show when={props.card.comparison}>
        {(sides) => (
          <div class="understanding-compare">
            <For each={sides()}>
              {(side) => (
                <section class="understanding-compare-side">
                  <p class="understanding-card-label" style={{ color: theme.fgMuted }}>
                    {side.label}
                  </p>
                  <p class="understanding-compare-text">{side.text}</p>
                </section>
              )}
            </For>
          </div>
        )}
      </Show>
      <div
        class="understanding-body plan-markdown"
        // eslint-disable-next-line solid/no-innerhtml -- createHighlightedMarkdown sanitizes with DOMPurify
        innerHTML={bodyHtml()}
      />
      {/* Collapsed: the quote answers "where does it say that?" without adding
          a second body to read. groundTour() already checked it is verbatim. */}
      <Show when={props.card.source}>
        {(source) => (
          <details class="understanding-source">
            <summary>Source</summary>
            <blockquote>{source()}</blockquote>
          </details>
        )}
      </Show>
      <Show when={props.card.whyItMatters}>
        {(why) => (
          <div class="understanding-why">
            <p class="understanding-card-label" style={{ color: theme.fgMuted }}>
              Why this matters
            </p>
            <p class="understanding-why-text">{why()}</p>
          </div>
        )}
      </Show>
      <Show when={props.card.refs.length > 0 && props.onOpenRef}>
        <div class="understanding-refs">
          <For each={props.card.refs}>
            {(ref) => (
              <button
                class="understanding-ref"
                type="button"
                onClick={() => props.onOpenRef?.(ref)}
              >
                <FileGlyph />
                {refLabel(ref)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.omitted?.length}>
        <p class="understanding-omitted" style={{ color: theme.fgMuted }}>
          Not covered: {props.omitted?.join(', ')}
        </p>
      </Show>
      <Show when={props.onAsk && questions().length > 0}>
        <div class="tour-questions" role="group" aria-label="Explore this card">
          <For each={questions()}>
            {(question) => (
              <button
                type="button"
                class="tour-question"
                disabled={props.asking}
                onClick={() => props.onAsk?.(question)}
              >
                <span aria-hidden="true">↳</span>
                <span>{question}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </article>
  );
}

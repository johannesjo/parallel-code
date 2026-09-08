import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  createAnchorEffect,
  createHeldSignal,
  placeBelow,
  type BelowAnchor,
} from '../lib/floating';
import { AnnotationBubble } from './AnnotationBubble';
import type { DocumentAnnotation } from './types';
import { registerPinnedBubble } from './workspace-ui';

interface AnnotationMarkerProps {
  annotations: DocumentAnnotation[];
  onMakeTask: (annotation: DocumentAnnotation) => void;
}

/** Widest the popover gets; narrower windows leave a margin either side. */
const POP_WIDTH = 440;
const EDGE = 12;
/** How long the popover stays once the pointer leaves it or the symbol. */
const HOVER_HOLD_MS = 150;

/**
 * Flush under the symbol, right-aligned with it, and kept inside the window;
 * above the symbol when the popover would not fit below and has more room up.
 */
function placePopover(anchor: DOMRect, height?: number): BelowAnchor {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  return placeBelow(anchor, Math.min(POP_WIDTH, viewport.width - 64), viewport, EDGE, height);
}

function describe(annotations: readonly DocumentAnnotation[]): string {
  const questions = annotations.filter((a) => a.kind === 'question').length;
  const notes = annotations.length - questions;
  const parts: string[] = [];
  if (notes > 0) parts.push(`${notes} note${notes === 1 ? '' : 's'}`);
  if (questions > 0) parts.push(`${questions} question${questions === 1 ? '' : 's'}`);
  return `${parts.join(' and ')} on this passage`;
}

/** A question the agent has not come back on yet. */
function isAwaitingAnswer(annotation: DocumentAnnotation): boolean {
  return annotation.kind === 'question' && annotation.answerStatus === 'pending';
}

/**
 * The notes on a passage as a symbol in its margin. They open over the
 * document on hover, on keyboard focus, or pinned by a click, so the prose
 * reads exactly as it does without them. The popover floats over the window
 * rather than sitting in the block: a page's own CSS can clip what is inside
 * its elements, and nothing in the workspace may paint over an open note.
 */
export function AnnotationMarker(props: AnnotationMarkerProps) {
  let root: HTMLDivElement | undefined;
  let button: HTMLButtonElement | undefined;
  let pop: HTMLDivElement | undefined;
  const [pinned, setPinned] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const hover = createHeldSignal<true>(HOVER_HOLD_MS);
  const open = () => pinned() || focused() || hover.value() === true;
  const [pos, setPos] = createSignal<BelowAnchor | null>(null);
  const awaiting = () => props.annotations.some(isAwaitingAnswer);
  const label = () =>
    `${describe(props.annotations)}${awaiting() ? ', waiting for an answer' : ''}`;

  createAnchorEffect(open, () => {
    // The popover is hidden with visibility, not display, so its height is
    // measurable before it opens.
    if (button) setPos(placePopover(button.getBoundingClientRect(), pop?.offsetHeight));
  });

  /** The symbol and its popover count as one thing for focus and clicks. */
  const inside = (node: EventTarget | null) =>
    node instanceof Node && (!!root?.contains(node) || !!pop?.contains(node));

  // A pinned bubble covers the prose, so anything else the reader does closes it.
  createEffect(() => {
    if (!pinned()) return;
    const close = (e: MouseEvent) => {
      if (!inside(e.target)) setPinned(false);
    };
    document.addEventListener('mousedown', close);
    onCleanup(() => document.removeEventListener('mousedown', close));
  });

  /**
   * Shuts the bubble however it was opened. Focus goes back to the symbol
   * first when it sat inside the popover, so it is not dropped as that hides.
   */
  function close() {
    if (pop?.contains(document.activeElement)) button?.focus();
    setPinned(false);
    setFocused(false);
    hover.clear();
  }

  // Escape anywhere in the workspace closes a pinned bubble before anything
  // else does; with the focus elsewhere, the handler below never sees the key.
  createEffect(() => {
    if (!pinned()) return;
    onCleanup(registerPinnedBubble(close));
  });

  // Bound natively, not delegated: the key has to stop at the bubble, before
  // the window's shortcuts or a dialog under the popover take it for their own
  // Escape and close the whole workspace along with the note.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !open()) return;
    e.stopPropagation();
    close();
  }

  function onFocusOut(e: FocusEvent) {
    if (!inside(e.relatedTarget)) setFocused(false);
  }

  return (
    <div
      ref={root}
      class="docws-marker"
      classList={{
        'is-pinned': pinned(),
        'is-question': props.annotations.some((a) => a.kind === 'question'),
      }}
      on:keydown={onKeyDown}
      onMouseEnter={() => hover.set(true)}
      onMouseLeave={() => hover.clear()}
      onFocusIn={() => setFocused(true)}
      onFocusOut={onFocusOut}
    >
      <button
        ref={button}
        type="button"
        class="docws-marker-btn"
        aria-label={label()}
        aria-expanded={pinned()}
        onClick={(e) => {
          const next = !pinned();
          setPinned(next);
          // Focus alone holds the bubble open, so a click that closes it has to
          // give the focus back. A keyboard activation (detail 0) keeps it.
          if (!next && e.detail > 0) e.currentTarget.blur();
        }}
      >
        {/* A question waiting on its agent spins in the margin, so the wait is
            visible without opening the bubble to read "Answering…". */}
        <Show
          when={awaiting()}
          fallback={
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.4" />
              <path d="M4.6 6.4h6.8M4.6 9.4h4.2" />
            </svg>
          }
        >
          <span class="inline-spinner" aria-hidden="true" />
        </Show>
        <Show when={props.annotations.length > 1}>
          <span class="docws-marker-count">{props.annotations.length}</span>
        </Show>
      </button>
      <Portal>
        <div
          ref={pop}
          class="docws-marker-pop"
          classList={{ 'is-open': open() && pos() !== null }}
          role="group"
          aria-label={label()}
          style={{
            top: `${pos()?.top ?? 0}px`,
            right: `${pos()?.right ?? 0}px`,
            'max-height': `min(60vh, ${pos()?.maxHeight ?? 0}px)`,
          }}
          on:keydown={onKeyDown}
          onMouseEnter={() => hover.set(true)}
          onMouseLeave={() => hover.clear()}
          onFocusIn={() => setFocused(true)}
          onFocusOut={onFocusOut}
        >
          <For each={props.annotations}>
            {(annotation) => (
              <AnnotationBubble annotation={annotation} onMakeTask={props.onMakeTask} />
            )}
          </For>
        </div>
      </Portal>
    </div>
  );
}

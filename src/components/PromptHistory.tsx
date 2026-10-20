import { For, Show, createEffect, createSignal, createUniqueId, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { createAnchorEffect, placeBelow } from '../lib/floating';
import type { BelowAnchor } from '../lib/floating';
import type { Task } from '../store/types';
import { promptHistoryOf } from '../lib/prompt-history';

export function PromptHistory(props: { task: Task; emptyLabel: string }) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const history = () => promptHistoryOf(props.task);
  const [position, setPosition] = createSignal<BelowAnchor>({ top: 0, right: 0, maxHeight: 360 });
  let anchor: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  const contains = (node: Node | null) =>
    !!node && (anchor?.contains(node) || popover?.contains(node));
  const blur = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !contains(event.relatedTarget)) setOpen(false);
  };

  createAnchorEffect(open, () => {
    if (!anchor) return;
    setPosition(
      placeBelow(
        anchor.getBoundingClientRect(),
        Math.min(420, window.innerWidth - 24),
        { width: window.innerWidth, height: window.innerHeight },
        12,
        360,
      ),
    );
  });
  createEffect(() => {
    if (!open()) return;
    // Newest prompts are last. Deferred until the placed max-height lands, or the
    // popover would scroll against its stale height and stop short of the end.
    queueMicrotask(() => {
      if (popover) popover.scrollTop = popover.scrollHeight;
    });
  });
  createEffect(() => {
    if (!open()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (popover?.contains(document.activeElement)) anchor?.focus();
      setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    onCleanup(() => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    });
  });

  return (
    <>
      <button
        ref={anchor}
        type="button"
        class="prompt-history-trigger"
        aria-label="Prompt history"
        aria-expanded={open()}
        aria-controls={open() ? id : undefined}
        onBlur={blur}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open());
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            popover?.focus();
          }
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M2 7a6 6 0 1 1 1.5 5M2 3v4h4M8 4.5V8l2.5 1.5" />
        </svg>
        <span>{props.task.lastPrompt || props.emptyLabel}</span>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={popover}
            id={id}
            role="region"
            aria-label="Prompt history"
            tabIndex={0}
            class="prompt-history-popover"
            onClick={(event) => event.stopPropagation()}
            onFocusOut={blur}
            style={{
              top: `${position().top}px`,
              right: `${position().right}px`,
              'max-height': `${Math.min(360, position().maxHeight)}px`,
            }}
          >
            <Show when={history().length} fallback={<p>No prompts sent yet.</p>}>
              <ol>
                <For each={history()}>
                  {(entry) => (
                    <li>
                      <p>{entry.text}</p>
                      <Show when={entry.sentAt}>
                        {(time) => (
                          <time
                            class="prompt-history-meta"
                            title={new Date(time()).toLocaleString()}
                          >
                            {new Date(time()).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}

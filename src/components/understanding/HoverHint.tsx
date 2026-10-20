import { Show, createSignal, createUniqueId, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  createAnchorEffect,
  createHeldSignal,
  placeBelow,
  type BelowAnchor,
} from '../../lib/floating';

const HINT_WIDTH = 300;
/** Room the hint needs; placeBelow flips it above the control when the foot is close. */
const HINT_HEIGHT = 200;

/**
 * Hover and focus popover anchored to a control. Wraps the control; `children`
 * renders it and gives it `aria-describedby={describedBy()}`, and `hint`
 * renders the popover body from the `.tour-hint-*` parts.
 */
export function HoverHint(props: {
  hint: () => JSX.Element;
  /** Extra class on the wrapper, for callers that position the control through it. */
  class?: string;
  children: (describedBy: () => string | undefined) => JSX.Element;
}) {
  const id = createUniqueId();
  const held = createHeldSignal<boolean>(150);
  const open = () => !!held.value();
  const [position, setPosition] = createSignal<BelowAnchor>({ top: 0, right: 0, maxHeight: 0 });
  let anchor: HTMLDivElement | undefined;

  createAnchorEffect(open, () => {
    if (!anchor) return;
    setPosition(
      placeBelow(
        anchor.getBoundingClientRect(),
        Math.min(HINT_WIDTH, window.innerWidth - 24),
        { width: window.innerWidth, height: window.innerHeight },
        12,
        HINT_HEIGHT,
      ),
    );
  });

  return (
    <>
      <div
        ref={anchor}
        class={props.class ? `tour-hint-anchor ${props.class}` : 'tour-hint-anchor'}
        onMouseEnter={() => held.set(true)}
        onMouseLeave={() => {
          if (!anchor?.contains(document.activeElement)) held.clear();
        }}
        onFocusIn={() => held.set(true)}
        onFocusOut={(event) => {
          if (!(event.relatedTarget instanceof Node) || !anchor?.contains(event.relatedTarget))
            held.set(false);
        }}
      >
        {props.children(() => (open() ? id : undefined))}
      </div>
      <Show when={open()}>
        <Portal>
          <div
            id={id}
            role="tooltip"
            class="tour-hint"
            style={{
              top: `${position().top}px`,
              right: `${position().right}px`,
              width: `${HINT_WIDTH}px`,
            }}
          >
            {props.hint()}
          </div>
        </Portal>
      </Show>
    </>
  );
}

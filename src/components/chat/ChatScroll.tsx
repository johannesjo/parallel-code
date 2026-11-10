import { Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';

const SCROLL_UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);

/** Native scrolling keeps the reader in charge while streaming and disclosures resize.
 *  The log follows new output only while the reader is at the bottom. */
export function ChatScroll(props: {
  children: JSX.Element;
  /** Receives a way to bring the newest message into view, e.g. after sending, and
   *  one to stop following before scrolling the reader somewhere else. */
  onControls?: (controls: { toLatest: () => void; hold: () => void }) => void;
}) {
  let scroll: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  let following = true;
  let lastTop = 0;
  const [latest, setLatest] = createSignal(true);
  const atBottom = (element: HTMLElement) =>
    element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  function bottom() {
    if (!scroll) return;
    following = true;
    scroll.scrollTop = scroll.scrollHeight;
    lastTop = scroll.scrollTop;
    setLatest(true);
  }
  /** Settle a click once it has done its work: one that opened a disclosure has
   *  grown the log below the reader, who stays put; any other click resumes. A
   *  cancelled pointer became a native scroll, whose scroll events decide instead. */
  function release(event: PointerEvent) {
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
    if (event.type === 'pointercancel') return;
    requestAnimationFrame(() => {
      if (scroll && atBottom(scroll)) bottom();
    });
  }
  onMount(() => {
    props.onControls?.({
      toLatest: bottom,
      hold: () => {
        following = false;
      },
    });
    if (!scroll || !content) return;
    const observer = new ResizeObserver(() => {
      if (following) return bottom();
      if (!scroll) return;
      // Layout flips reparent the log (see TaskPanel), and Chromium resets a moved
      // scroller to the top without a scroll event. A reader's own scroll there
      // records 0 first, so a 0 with a stale offset can only be such a reset.
      // shortcut: restores the old offset, which drifts if the width reflowed text.
      if (scroll.scrollTop === 0 && lastTop > 0) scroll.scrollTop = lastTop;
      setLatest(atBottom(scroll));
    });
    observer.observe(scroll);
    observer.observe(content);
    bottom();
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    });
  });
  return (
    <div class="chat-scroll-container">
      <div
        ref={scroll}
        class="chat-scroll"
        // Only the reader's own input pauses following. A scroll event never does:
        // output streamed in after our own scroll makes its event look short of the
        // bottom. Coming back down resumes, but an upward scroll still in flight
        // passes through the bottom zone and must not.
        onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollTop >= lastTop && atBottom(element)) following = true;
          lastTop = element.scrollTop;
          setLatest(following);
        }}
        onWheel={(event) => {
          if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) following = false;
        }}
        onKeyDown={(event) => {
          if (SCROLL_UP_KEYS.has(event.key)) following = false;
        }}
        onPointerDown={() => {
          following = false;
          window.addEventListener('pointerup', release);
          window.addEventListener('pointercancel', release);
        }}
      >
        <div ref={content}>{props.children}</div>
      </div>
      <Show when={!latest()}>
        <button class="chat-jump" aria-label="Jump to latest message" onClick={bottom}>
          ↓ Latest
        </button>
      </Show>
    </div>
  );
}

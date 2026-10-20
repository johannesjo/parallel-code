// Whether the main mouse button is held anywhere in the window. A comment
// opens on the press; taking focus before the release would end a drag that
// is selecting text.
let held = false;
// A Ctrl+click opens the context menu on macOS, which may swallow its release.
document.addEventListener(
  'mousedown',
  (e) => (held = (e.button === 0 && !e.ctrlKey) || held),
  true,
);
document.addEventListener('mouseup', () => (held = false), true);
window.addEventListener('blur', () => (held = false));
// A drag of text or a link ends without a mouseup.
document.addEventListener('dragend', () => (held = false), true);

/** Dragging the document's scrollbar is reading on, not leaving a comment or an edit. */
export function onScrollbar(e: MouseEvent): boolean {
  const el = e.target;
  return (
    el instanceof HTMLElement &&
    (e.offsetX >= el.clientWidth || e.offsetY >= el.clientHeight) &&
    (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
  );
}

/**
 * Runs `fn` now, or once the held mouse button is released and its click has
 * been handled (the workspace takes focus on a click).
 */
export function afterPress(fn: () => void): void {
  if (!held) return fn();
  // A press the window lost has no release to wait for; it ends there, and a
  // later click is not it. A press that became a drag ends on its drop, which
  // keeps the focus where it landed.
  const wait = new AbortController();
  const release = () => {
    wait.abort();
    setTimeout(fn);
  };
  document.addEventListener('mouseup', release, { capture: true, signal: wait.signal });
  window.addEventListener('blur', release, { signal: wait.signal });
  document.addEventListener('dragend', () => wait.abort(), { capture: true, signal: wait.signal });
}

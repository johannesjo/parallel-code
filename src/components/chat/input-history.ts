export interface InputHistory {
  /** Handles ArrowUp/ArrowDown; true when the key was used. */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface InputHistoryOptions {
  /** Earlier messages, oldest first. */
  entries: () => string[];
  draft: () => string;
  /** `recalled` is false when the draft typed before browsing is put back. */
  onDraft: (text: string, recalled: boolean) => void;
}

interface Browsing {
  index: number;
  /** The text typed before browsing began, restored by stepping past the newest entry. */
  stash: string;
  /** What we last wrote, so an edit by the user ends browsing. */
  shown: string;
  /** A send grows the list, which would leave `index` pointing at the wrong entry. */
  count: number;
}

/** Measure soft wraps using the same text layout as the textarea. */
function onVisualEdge(area: HTMLTextAreaElement, up: boolean): boolean {
  const caret = area.selectionStart;
  const edge = up ? 0 : area.value.length;
  if (caret === edge || !area.clientWidth || area.wrap === 'off') return true;
  const style = getComputedStyle(area);
  const mirror = document.createElement('div');
  for (const property of [
    'font',
    'letter-spacing',
    'word-spacing',
    'text-indent',
    'text-transform',
    'tab-size',
    'word-break',
    'overflow-wrap',
    'direction',
  ]) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  mirror.style.position = 'fixed';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.width = `${area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`;
  // Keep a final empty line measurable without changing the text before it.
  const text = document.createTextNode(`${area.value}\u200b`);
  mirror.append(text);
  document.body.append(mirror);
  try {
    const range = document.createRange();
    range.setStart(text, caret);
    range.collapse(true);
    const caretTop = range.getBoundingClientRect().top;
    range.setStart(text, edge);
    range.collapse(true);
    return Math.abs(caretTop - range.getBoundingClientRect().top) < 1;
  } finally {
    mirror.remove();
  }
}

/**
 * Shell-style recall of earlier messages with ArrowUp / ArrowDown. Arrows only
 * recall while the caret is on the first / last line, so multi-line drafts
 * still move the caret normally.
 */
export function createInputHistory(options: InputHistoryOptions): InputHistory {
  let browsing: Browsing | undefined;

  /** Returns the text to show, or undefined when the key has nothing to do. */
  function step(direction: -1 | 1, entries: string[]): string | undefined {
    if (!browsing) {
      if (direction === 1) return undefined;
      browsing = {
        index: entries.length,
        stash: options.draft(),
        shown: '',
        count: entries.length,
      };
    }
    const next = browsing.index + direction;
    if (next < 0) return browsing.shown;
    browsing.index = next;
    if (next >= entries.length) {
      const { stash } = browsing;
      browsing = undefined;
      options.onDraft(stash, false);
      return stash;
    }
    browsing.shown = entries[next] ?? '';
    options.onDraft(browsing.shown, true);
    return browsing.shown;
  }

  function onKeyDown(event: KeyboardEvent): boolean {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    if (event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
      return false;
    const area = event.currentTarget;
    if (!(area instanceof HTMLTextAreaElement)) return false;
    const entries = options.entries();
    if (browsing && (options.draft() !== browsing.shown || entries.length !== browsing.count))
      browsing = undefined;
    if (area.selectionStart !== area.selectionEnd) return false;
    const up = event.key === 'ArrowUp';
    const caret = area.selectionStart;
    const onEdge = up
      ? !area.value.slice(0, caret).includes('\n')
      : !area.value.slice(caret).includes('\n');
    if (!onEdge || (up && !entries.length) || !onVisualEdge(area, up)) return false;
    const text = step(up ? -1 : 1, entries);
    if (text === undefined) return false;
    event.preventDefault();
    event.stopPropagation();
    // Up leaves the caret on the first line so the next Up keeps recalling,
    // even after a multi-line message; the textarea takes its new value first.
    const position = up ? 0 : text.length;
    queueMicrotask(() => area.setSelectionRange(position, position));
    return true;
  }

  return { onKeyDown };
}

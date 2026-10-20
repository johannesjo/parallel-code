import type { Viewport } from './floating';

interface Rect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface HintPlacement {
  left: number;
  /** Set when the card hangs below its anchor or beside a dialog. */
  top?: number;
  /** Set when the card sits above its anchor, so its own height never opens a gap. */
  bottom?: number;
  maxHeight: number;
  /** The card's edge that points at the anchor, and where along it, in px. */
  caret: { side: 'top' | 'bottom' | 'left' | 'right'; offset: number };
}

/** Kept clear of the viewport's edges. */
const EDGE = 12;
/** Between the anchor and the card, with room for the caret. */
const GAP = 8;
/** The caret stays clear of the card's rounded corners. */
const CARET_INSET = 16;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where a tip goes. Inside a dialog it stays off the panel, so it covers none
 * of the dialog: beside it, level with the anchor's first line, else under or
 * over it. Without room for that, and outside dialogs, it hangs under the
 * anchor, right-aligned, or above it when there is more room above. `height`
 * is an estimate: it only decides where the card fits.
 */
export function placeHint(
  anchor: Rect,
  viewport: Viewport,
  width: number,
  height: number,
  panel?: Rect,
): HintPlacement {
  if (panel) {
    const right = panel.right + GAP;
    const left = panel.left - GAP - width;
    const side =
      right + width <= viewport.width - EDGE ? 'left' : left >= EDGE ? 'right' : undefined;
    if (side) {
      const line = anchor.top + Math.min((anchor.bottom - anchor.top) / 2, 16);
      const top = clamp(line - CARET_INSET * 2, EDGE, viewport.height - EDGE - height);
      return {
        left: side === 'left' ? right : left,
        top,
        maxHeight: Math.max(120, viewport.height - EDGE - top),
        caret: { side, offset: Math.max(CARET_INSET, line - top) },
      };
    }
  }

  const left = clamp(anchor.right - width, EDGE, viewport.width - width - EDGE);
  const center = (anchor.left + anchor.right) / 2;
  const offset = clamp(center - left, CARET_INSET, width - CARET_INSET);
  if (panel) {
    const under = viewport.height - panel.bottom - GAP - EDGE;
    if (under >= height)
      return { left, top: panel.bottom + GAP, maxHeight: under, caret: { side: 'top', offset } };
    const over = panel.top - GAP - EDGE;
    if (over >= height)
      return {
        left,
        bottom: viewport.height - panel.top + GAP,
        maxHeight: over,
        caret: { side: 'bottom', offset },
      };
  }
  const below = viewport.height - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  if (height > below && above > below) {
    return {
      left,
      bottom: viewport.height - anchor.top + GAP,
      maxHeight: Math.max(120, above),
      caret: { side: 'bottom', offset },
    };
  }
  return {
    left,
    top: anchor.bottom + GAP,
    maxHeight: Math.max(120, below),
    caret: { side: 'top', offset },
  };
}

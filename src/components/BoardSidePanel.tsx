import { Show, createSignal, onCleanup } from 'solid-js';
import { withViewTransition } from '../lib/viewTransition';
import { store } from '../store/core';
import { closeBoardSidePanel } from '../store/project-pages';
import { deletePanelUserSize, getPanelUserSize, setPanelUserSize } from '../store/ui';
import { focusBoardCard } from './task-board-keys';
import { ChevronRightSmallIcon } from './icons';

const WIDTH_KEY = 'board:side-panel';
const MIN_WIDTH = 360;
/** The board keeps this much room so its first lane stays readable. */
const BOARD_MIN_WIDTH = 320;
/** Arrow keys on the handle of a panel right of the board; mirrored for one on its left. */
const KEY_STEPS: Record<string, number> = { ArrowLeft: 24, ArrowRight: -24 };

/** -1 when the panel sits right of the board, so a leftward move widens it. */
function widenSign(): number {
  return store.boardSidePanelLeft ? 1 : -1;
}

/** The side panel's dragged width as a flex basis; unset falls back to the CSS default. */
export function boardSidePanelBasis(): string | undefined {
  const px = getPanelUserSize(WIDTH_KEY);
  return px === undefined ? undefined : `${px}px`;
}

/**
 * Closes the side panel and returns focus to the card that opened it. A draft
 * stays: only its own Cancel discards it, after asking if anything was typed.
 */
export function closeSidePanel(): void {
  withViewTransition(() => {
    // Read here, not before: a card opened just before may not have applied yet.
    const id = store.activeTaskId;
    closeBoardSidePanel();
    if (id) focusBoardCard(id);
  });
}

/**
 * Sits on the panel's edge facing the board, the boundary it collapses, so it
 * stays clear of the task header's own close button, which closes the task.
 * A draft gets none: only its own Cancel discards it.
 */
export function BoardSidePanelClose() {
  return (
    <Show when={!store.showNewTaskPanel}>
      <button
        type="button"
        class="board-side-panel-close"
        title="Close side panel (Escape)"
        aria-label="Close side panel"
        onClick={() => closeSidePanel()}
      >
        {/* Points the way the panel leaves: towards its own edge of the window. */}
        <ChevronRightSmallIcon
          size={10}
          style={{ transform: store.boardSidePanelLeft ? 'scaleX(-1)' : undefined }}
        />
      </button>
    </Show>
  );
}

/** Clamps a panel width so both the panel and the board beside it stay usable. */
function clampWidth(panel: HTMLElement, width: number): number {
  const board = document.querySelector('.task-board');
  const panelWidth = panel.getBoundingClientRect().width;
  const room = board ? board.getBoundingClientRect().width - BOARD_MIN_WIDTH : 0;
  return Math.round(Math.max(MIN_WIDTH, Math.min(panelWidth + room, width)));
}

/** The side panel's edge facing the board: drag or arrow keys resize, double-click resets. */
export function BoardSidePanelHandle() {
  const [dragging, setDragging] = createSignal(false);
  const [range, setRange] = createSignal<{ now: number; max: number }>();
  let stopDrag: (() => void) | undefined;
  onCleanup(() => stopDrag?.());

  function startDrag(e: MouseEvent) {
    const panel = (e.currentTarget as HTMLElement).parentElement;
    if (e.button !== 0 || !panel) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    // The bound comes from the layout at drag start; the drag changes it.
    const max = clampWidth(panel, Infinity);
    setDragging(true);
    const sign = widenSign();
    const onMove = (ev: MouseEvent) =>
      setPanelUserSize(
        WIDTH_KEY,
        Math.round(Math.max(MIN_WIDTH, Math.min(max, startWidth + sign * (ev.clientX - startX)))),
      );
    stopDrag = () => {
      measure(panel);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('blur', stop);
      stopDrag = undefined;
      setDragging(false);
    };
    const stop = () => stopDrag?.();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
  }

  // Measured on focus and after each resize rather than tracked live: only a
  // screen reader on the focused handle reads these values.
  function measure(panel: HTMLElement) {
    const now = Math.round(panel.getBoundingClientRect().width);
    setRange({ now, max: clampWidth(panel, Infinity) });
  }

  function nudge(e: KeyboardEvent) {
    const step = (KEY_STEPS[e.key] ?? 0) * -widenSign();
    const panel = (e.currentTarget as HTMLElement).parentElement;
    if (!step || !panel) return;
    e.preventDefault();
    const width = clampWidth(panel, panel.getBoundingClientRect().width + step);
    setPanelUserSize(WIDTH_KEY, width);
    setRange({ now: width, max: range()?.max ?? width });
  }

  return (
    <div
      class="resize-handle resize-handle-h board-side-panel-handle"
      classList={{ dragging: dragging() }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      aria-valuenow={range()?.now}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={range()?.max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onMouseDown={startDrag}
      onFocus={(e) => {
        if (e.currentTarget.parentElement) measure(e.currentTarget.parentElement);
      }}
      onKeyDown={nudge}
      onDblClick={(e) => {
        deletePanelUserSize([WIDTH_KEY]);
        if (e.currentTarget.parentElement) measure(e.currentTarget.parentElement);
      }}
    />
  );
}

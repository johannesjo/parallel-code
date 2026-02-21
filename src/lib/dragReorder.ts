/**
 * Shared drag-to-reorder logic for task and terminal panels.
 * Handles mouse drag with threshold, drop indicator positioning,
 * and reorder callback.
 */

const DRAG_THRESHOLD = 5;

interface DragReorderOpts {
  /** ID of the dragged item (used to find its index in taskOrder). */
  itemId: string;
  /** Current task order array. */
  getTaskOrder: () => string[];
  /** Called when the item is dropped at a new position. */
  onReorder: (fromIdx: number, toIdx: number) => void;
  /** Called on a click (no drag). */
  onTap: () => void;
}

export function handleDragReorder(e: MouseEvent, opts: DragReorderOpts): void {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button") || target.tagName === "INPUT") return;

  e.preventDefault();
  const startX = e.clientX;
  const titleBarEl = e.currentTarget as HTMLElement;
  const draggedCol = titleBarEl.closest("[data-task-id]") as HTMLElement;
  const sizeWrapper = draggedCol.parentElement;
  const columnsContainer = sizeWrapper?.parentElement as HTMLElement;
  if (!columnsContainer) return;

  let dragging = false;
  let lastDropIdx = -1;
  let indicator: HTMLElement | null = null;

  function getColumns(): HTMLElement[] {
    return Array.from(columnsContainer.querySelectorAll<HTMLElement>("[data-task-id]"));
  }

  function computeDropIndex(clientX: number): number {
    const columns = getColumns();
    for (let i = 0; i < columns.length; i++) {
      const rect = columns[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return columns.length;
  }

  function positionIndicator(dropIdx: number): void {
    if (!indicator) return;
    const columns = getColumns();
    const containerRect = columnsContainer.getBoundingClientRect();
    let x: number;

    if (dropIdx < columns.length) {
      const parent = columns[dropIdx].parentElement;
      if (!parent) return;
      x = parent.getBoundingClientRect().left;
    } else if (columns.length > 0) {
      const parent = columns[columns.length - 1].parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      x = rect.right;
    } else {
      x = containerRect.left;
    }

    indicator.style.left = `${x - 1}px`;
    indicator.style.top = `${containerRect.top}px`;
    indicator.style.height = `${containerRect.height}px`;
  }

  function onMove(ev: MouseEvent): void {
    if (!dragging && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return;

    if (!dragging) {
      dragging = true;
      document.body.classList.add("dragging-task");
      draggedCol.style.opacity = "0.4";
      indicator = document.createElement("div");
      indicator.className = "drag-drop-indicator";
      document.body.appendChild(indicator);
    }

    const dropIdx = computeDropIndex(ev.clientX);
    if (dropIdx !== lastDropIdx) {
      lastDropIdx = dropIdx;
      positionIndicator(dropIdx);
    }
  }

  function onUp(): void {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);

    if (dragging) {
      document.body.classList.remove("dragging-task");
      draggedCol.style.opacity = "";
      indicator?.remove();
      indicator = null;

      const fromIdx = opts.getTaskOrder().indexOf(opts.itemId);
      if (fromIdx !== -1 && lastDropIdx !== -1 && fromIdx !== lastDropIdx) {
        const adjustedTo = lastDropIdx > fromIdx ? lastDropIdx - 1 : lastDropIdx;
        opts.onReorder(fromIdx, adjustedTo);
      }
    } else {
      opts.onTap();
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

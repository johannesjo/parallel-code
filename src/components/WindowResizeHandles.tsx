import { For } from 'solid-js';
import { appWindow } from '../lib/window';

type ResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West';

const resizeHandles: Array<{ className: string; direction: ResizeDirection }> = [
  { className: 'n', direction: 'North' },
  { className: 's', direction: 'South' },
  { className: 'e', direction: 'East' },
  { className: 'w', direction: 'West' },
  { className: 'ne', direction: 'NorthEast' },
  { className: 'nw', direction: 'NorthWest' },
  { className: 'se', direction: 'SouthEast' },
  { className: 'sw', direction: 'SouthWest' },
];

export function WindowResizeHandles() {
  const startResize = (event: MouseEvent, direction: ResizeDirection) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    void appWindow.startResizeDragging(direction).catch((error) => {
      console.warn(`Failed to start resize dragging (${direction})`, error);
    });
  };

  return (
    <div class="window-resize-handles" aria-hidden="true">
      <For each={resizeHandles}>
        {(handle) => (
          <div
            class={`window-resize-handle ${handle.className}`}
            onMouseDown={(event) => startResize(event, handle.direction)}
          />
        )}
      </For>
    </div>
  );
}

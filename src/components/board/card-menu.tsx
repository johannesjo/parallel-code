import { Show, createSignal, type JSX } from 'solid-js';
import { ContextMenu, type MoreMenuItem } from '../chat/MoreMenu';
import { menuPointFor } from '../project-menu';

const stop = (event: Event) => event.stopPropagation();

/**
 * A right-click menu for a board card that is not a task (a terminal, a
 * document). Task cards use createTaskContextMenu, which also hosts dialogs.
 */
export function createCardMenu(options: { label: () => string; items: () => MoreMenuItem[] }): {
  onContextMenu: (event: MouseEvent) => void;
  Menu: () => JSX.Element;
} {
  const [at, setAt] = createSignal<{ x: number; y: number }>();
  return {
    onContextMenu: (event) => {
      event.preventDefault();
      setAt(menuPointFor(event, event.currentTarget as Element | null));
    },
    // Solid forwards delegated events from portals to the DOM around them, so the
    // wrapper keeps menu clicks and keys from also activating the card.
    Menu: () => (
      <div style={{ display: 'contents' }} onClick={stop} onKeyDown={stop} onContextMenu={stop}>
        <Show when={at()}>
          {(point) => (
            <ContextMenu
              items={options.items()}
              at={point()}
              label={options.label()}
              onClose={() => setAt(undefined)}
            />
          )}
        </Show>
      </div>
    ),
  };
}

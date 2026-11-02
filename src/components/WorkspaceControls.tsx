import { For, type JSX } from 'solid-js';
import { isHiddenAgentTaskId } from '../documents/task-id';
import {
  setWorkspaceView,
  store,
  toggleSettingsDialog,
  toggleSidebar,
  workspaceView,
  workspaceViewTransitionTypes,
  type WorkspaceView,
} from '../store/store';
import { mod } from '../lib/platform';
import { withViewTransition } from '../lib/viewTransition';
import { ChevronLeftAltIcon, GearIcon } from './icons';
import { FeatureHint } from './FeatureHint';
import { IconButton } from './IconButton';
import { ToggleButton, ToggleGroup } from './ToggleGroup';
import { UpdateButton } from './UpdateButton';

function viewIcon(body: JSX.Element) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.25"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}

// Drawn to stay distinct at 16px: one pane in corner brackets, equal tall
// columns, and top-aligned lanes of unequal height.
const VIEWS: { view: WorkspaceView; title: string; icon: () => JSX.Element }[] = [
  {
    view: 'focus',
    title: `Focus: one task (${mod}+Shift+F)`,
    icon: () =>
      viewIcon(
        <>
          <path d="M2 5.5V3.75A1.75 1.75 0 0 1 3.75 2H5.5M10.5 2h1.75A1.75 1.75 0 0 1 14 3.75V5.5M14 10.5v1.75A1.75 1.75 0 0 1 12.25 14H10.5M5.5 14H3.75A1.75 1.75 0 0 1 2 12.25V10.5" />
          <rect x="5" y="5" width="6" height="6" rx="1" />
        </>,
      ),
  },
  {
    view: 'tiles',
    title: 'Tiles: tasks side by side',
    icon: () =>
      viewIcon(
        <>
          <rect x="2" y="3" width="3.2" height="10" rx="0.8" />
          <rect x="6.4" y="3" width="3.2" height="10" rx="0.8" />
          <rect x="10.8" y="3" width="3.2" height="10" rx="0.8" />
        </>,
      ),
  },
  {
    view: 'board',
    title: `Board: running tasks by state (${mod}+Shift+G)`,
    icon: () =>
      viewIcon(
        <>
          <rect x="2" y="2.5" width="3.2" height="11" rx="0.8" />
          <rect x="6.4" y="2.5" width="3.2" height="6.5" rx="0.8" />
          <rect x="10.8" y="2.5" width="3.2" height="8.5" rx="0.8" />
        </>,
      ),
  },
];

/** Tiles get crowded from about this many tasks, where the board starts to pay off. */
const BOARD_HINT_MIN_TASKS = 3;

function visibleTaskCount(): number {
  return store.taskOrder.filter((id) => !isHiddenAgentTaskId(id)).length;
}

/** Focus, tiles or board: three views of the same tasks, one pressed at a time. */
function WorkspaceViewToggle() {
  let boardButton: HTMLButtonElement | undefined;
  return (
    <ToggleGroup label="Workspace view">
      <For each={VIEWS}>
        {(item) => (
          <ToggleButton
            ref={(el) => {
              if (item.view === 'board') boardButton = el;
            }}
            title={item.title}
            label={item.title}
            pressed={workspaceView() === item.view}
            onClick={() =>
              withViewTransition(
                () => setWorkspaceView(item.view),
                workspaceViewTransitionTypes(item.view),
              )
            }
          >
            {item.icon()}
          </ToggleButton>
        )}
      </For>
      <FeatureHint
        id="board-view"
        when={workspaceView() !== 'board' && visibleTaskCount() >= BOARD_HINT_MIN_TASKS}
        anchor={() => boardButton}
        title="See every task by what it needs"
        actions={[
          { label: 'Show board', run: () => withViewTransition(() => setWorkspaceView('board')) },
        ]}
      >
        The board sorts your tasks into lanes: waiting for you, still working, stopped, or in a pull
        request. Open any task beside it, and switch back here at any time.
      </FeatureHint>
    </ToggleGroup>
  );
}

export function WorkspaceControls() {
  return (
    <div
      class="workspace-controls"
      role="group"
      aria-label="Workspace controls"
      onDblClick={(event) => event.stopPropagation()}
    >
      <IconButton
        icon={
          <ChevronLeftAltIcon
            style={{ transform: store.sidebarVisible ? undefined : 'rotate(180deg)' }}
          />
        }
        onClick={() => toggleSidebar()}
        title={`${store.sidebarVisible ? 'Collapse' : 'Show'} sidebar (${mod}+B)`}
      />
      <IconButton
        icon={<GearIcon />}
        onClick={() => toggleSettingsDialog(true)}
        title={`Settings (${mod}+,)`}
      />
      <WorkspaceViewToggle />
      <UpdateButton />
    </div>
  );
}

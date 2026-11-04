import { store, setShellLayoutOverride } from '../store/store';
import { SHELL_LAYOUT_MODES, type ShellLayoutMode } from '../lib/shellLayout';
import { MoreMenu, type MoreMenuItem } from './chat/MoreMenu';
import { SparkleIcon } from './icons';

const LABELS: Record<ShellLayoutMode, string> = {
  row: 'Row',
  grid: 'Square grid',
  column: 'Column',
};

const ICON_PATHS: Record<ShellLayoutMode, string> = {
  row: 'M2.5 2.5h11v11h-11zM6.17 2.5v11M9.83 2.5v11',
  grid: 'M2.5 2.5h11v11h-11zM8 2.5v11M2.5 8h11',
  column: 'M2.5 2.5h11v11h-11zM2.5 6.17h11M2.5 9.83h11',
};

function LayoutIcon(props: { mode: ShellLayoutMode; pinned: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={ICON_PATHS[props.mode]} stroke="currentColor" stroke-width="1.25" />
      {/* A pinned layout no longer follows the column width; mark it quietly. */}
      {props.pinned && <circle cx="14" cy="2" r="2" fill="currentColor" />}
    </svg>
  );
}

/** One button for how a task's shells are arranged. It shows the layout in
 *  use; the menu pins a layout for every task or hands the choice back to the
 *  size-based pick. Kept out of the toolbar's arrow-key cells: it is a
 *  setting, not a launcher. */
export function ShellLayoutMenu(props: { taskId: string; mode: ShellLayoutMode }) {
  const items = (): MoreMenuItem[] => {
    const pinned = store.shellLayoutOverride;
    const auto = store.taskShellAutoLayout[props.taskId] ?? 'row';
    return [
      {
        label: `Automatic (${LABELS[auto]})`,
        title: 'Choose by the available width',
        icon: <SparkleIcon size={14} />,
        checked: pinned === null,
        run: () => setShellLayoutOverride(null),
      },
      ...SHELL_LAYOUT_MODES.map((mode) => ({
        label: LABELS[mode],
        icon: <LayoutIcon mode={mode} pinned={false} />,
        checked: pinned === mode,
        run: () => setShellLayoutOverride(mode),
      })),
    ];
  };
  return (
    <MoreMenu
      items={items()}
      label={`Terminal layout: ${LABELS[props.mode]}`}
      icon={<LayoutIcon mode={props.mode} pinned={store.shellLayoutOverride !== null} />}
      iconOnly
      class="shell-toolbar-button shell-layout-button"
    />
  );
}

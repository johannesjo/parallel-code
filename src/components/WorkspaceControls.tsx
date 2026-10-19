import { store, toggleSettingsDialog, toggleSidebar } from '../store/store';
import { mod } from '../lib/platform';
import { ChevronLeftAltIcon, GearIcon } from './icons';
import { IconButton } from './IconButton';
import { UpdateButton } from './UpdateButton';

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
      <UpdateButton />
    </div>
  );
}

import { onMount, onCleanup, For } from 'solid-js';
import { invoke, Channel } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, closeTask, mergeTask, showNotification } from '../store/store';

export interface TabDropdownMenuProps {
  taskId: string;
  anchorRect: { left: number; top: number; width: number; height: number };
  onClose: () => void;
}

export function TabDropdownMenu(props: TabDropdownMenuProps) {
  let menuRef!: HTMLDivElement;

  const task = () => store.tasks[props.taskId];

  onMount(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef && !menuRef.contains(e.target as Node)) {
        props.onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    onCleanup(() => document.removeEventListener('mousedown', handleMouseDown));
  });

  const menuItems: Array<{ label: string; action: () => void } | 'divider'> = [
    {
      label: 'Create PR',
      action: async () => {
        props.onClose();
        const t = task();
        if (!t) return;
        try {
          await window.electron.ipcRenderer.invoke('create_pr', { worktreePath: t.worktreePath });
        } catch (err) {
          showNotification(`Create PR failed: ${String(err)}`);
        }
      },
    },
    {
      label: 'Open PR in Browser',
      action: async () => {
        props.onClose();
        const t = task();
        if (!t) return;
        try {
          await window.electron.ipcRenderer.invoke('open_pr', { worktreePath: t.worktreePath });
        } catch (err) {
          showNotification(`Open PR failed: ${String(err)}`);
        }
      },
    },
    {
      label: 'Push to Remote',
      action: async () => {
        props.onClose();
        const t = task();
        if (!t) return;
        try {
          const channel = new Channel<string>();
          await invoke(IPC.PushTask, {
            projectRoot: t.worktreePath,
            branchName: t.branchName,
            onOutput: channel,
          });
          showNotification('Pushed successfully');
        } catch (err) {
          showNotification(`Push failed: ${String(err)}`);
        }
      },
    },
    {
      label: 'Merge to Main',
      action: async () => {
        props.onClose();
        try {
          await mergeTask(props.taskId, { squash: true, cleanup: true });
        } catch (err) {
          showNotification(`Merge failed: ${String(err)}`);
        }
      },
    },
    {
      label: 'Rebase onto Main',
      action: async () => {
        props.onClose();
        const t = task();
        if (!t) return;
        try {
          await invoke(IPC.RebaseTask, {
            worktreePath: t.worktreePath,
            baseBranch: t.baseBranch ?? 'main',
          });
          showNotification('Rebase complete');
        } catch (err) {
          showNotification(`Rebase failed: ${String(err)}`);
        }
      },
    },
    {
      label: 'Open in Editor',
      action: async () => {
        props.onClose();
        const t = task();
        if (!t) return;
        try {
          await invoke(IPC.ShellOpenInEditor, { path: t.worktreePath });
        } catch (err) {
          showNotification(`Open in editor failed: ${String(err)}`);
        }
      },
    },
    'divider',
    {
      label: 'Close Task',
      action: () => {
        props.onClose();
        closeTask(props.taskId);
      },
    },
  ];

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: `${props.anchorRect.left}px`,
        top: `${props.anchorRect.top + props.anchorRect.height + 2}px`,
        'min-width': '180px',
        background: 'var(--island-bg)',
        border: '1px solid var(--border-subtle)',
        'border-radius': '8px',
        'box-shadow': '0 8px 32px rgba(0,0,0,0.5)',
        padding: '4px 0',
        'z-index': '5000',
        'font-family': 'var(--font-ui)',
        'font-size': '13px',
      }}
    >
      <For each={menuItems}>
        {(item) =>
          item === 'divider' ? (
            <div
              style={{
                height: '1px',
                background: 'var(--border-subtle)',
                margin: '4px 0',
              }}
            />
          ) : (
            <button
              onClick={item.action}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 14px',
                background: 'transparent',
                border: 'none',
                color: 'var(--fg)',
                'text-align': 'left',
                cursor: 'pointer',
                'font-size': '13px',
                'font-family': 'var(--font-ui)',
                'border-radius': '0',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              {item.label}
            </button>
          )
        }
      </For>
    </div>
  );
}

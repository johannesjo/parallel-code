const { contextBridge, ipcRenderer } = require('electron');

// Allowlist of valid IPC channels.
// IMPORTANT: This list MUST stay in sync with the IPC enum in electron/ipc/channels.ts.
// The main process verifies this at startup — a mismatch will log a warning in dev.
const ALLOWED_CHANNELS = new Set([
  // Agent/PTY
  'spawn_agent',
  'write_to_agent',
  'resize_agent',
  'pause_agent',
  'resume_agent',
  'kill_agent',
  'count_running_agents',
  'kill_all_agents',
  'list_agents',
  // Task
  'create_task',
  'delete_task',
  // Git
  'get_changed_files',
  'get_changed_files_from_branch',
  'get_file_diff',
  'get_file_diff_from_branch',
  'get_gitignored_dirs',
  'get_worktree_status',
  'commit_all',
  'discard_uncommitted',
  'check_merge_status',
  'merge_task',
  'get_branch_log',
  'push_task',
  'rebase_task',
  'get_main_branch',
  'get_current_branch',
  // Persistence
  'save_app_state',
  'load_app_state',
  // Window
  '__window_is_focused',
  '__window_is_maximized',
  '__window_minimize',
  '__window_toggle_maximize',
  '__window_close',
  '__window_force_close',
  '__window_hide',
  '__window_maximize',
  '__window_unmaximize',
  '__window_set_size',
  '__window_set_position',
  '__window_get_position',
  '__window_get_size',
  '__window_focus',
  '__window_blur',
  '__window_resized',
  '__window_moved',
  '__window_close_requested',
  // Dialog
  '__dialog_confirm',
  '__dialog_open',
  // Shell
  '__shell_reveal',
  '__shell_open_file',
  // Arena
  'save_arena_data',
  'load_arena_data',
  'create_arena_worktree',
  'remove_arena_worktree',
  'check_path_exists',
  // Remote access
  'start_remote_server',
  'stop_remote_server',
  'get_remote_status',
]);

function isAllowedChannel(channel) {
  return ALLOWED_CHANNELS.has(channel) || channel.startsWith('channel:');
}

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    invoke: (channel, ...args) => {
      if (!isAllowedChannel(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
      return ipcRenderer.invoke(channel, ...args);
    },
    on: (channel, listener) => {
      if (!isAllowedChannel(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
      const wrapped = (_event, ...eventArgs) => listener(...eventArgs);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
    removeAllListeners: (channel) => {
      if (!isAllowedChannel(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
      ipcRenderer.removeAllListeners(channel);
    },
  },
});

const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

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
  'get_all_file_diffs',
  'get_all_file_diffs_from_branch',
  'get_gitignored_dirs',
  'list_importable_worktrees',
  'get_worktree_status',
  'commit_all',
  'discard_uncommitted',
  'check_merge_status',
  'merge_task',
  'get_branch_log',
  'get_branch_commits',
  'get_commit_changed_files',
  'get_commit_diffs',
  'get_uncommitted_changed_files',
  'get_uncommitted_file_diffs',
  'get_coverage_summary',
  'push_task',
  'rebase_task',
  'get_main_branch',
  'get_current_branch',
  'checkout_branch',
  'get_branches',
  'check_is_git_repo',
  // Persistence
  'save_app_state',
  'load_app_state',
  'load_custom_themes',
  'save_custom_theme',
  'delete_custom_theme',
  // Keybindings
  'load_keybindings',
  'save_keybindings',
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
  '__window_close_handling',
  // Dialog
  '__dialog_confirm',
  '__dialog_choice',
  '__dialog_open',
  // Shell
  '__shell_reveal',
  '__shell_open_file',
  '__shell_open_in_editor',
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
  // Plan
  'plan_content',
  'read_plan_content',
  'stop_plan_watcher',
  // Steps
  'steps_content',
  'read_steps_content',
  'stop_steps_watcher',
  // Docker
  'check_docker_available',
  'check_docker_image_exists',
  'build_docker_image',
  'resolve_project_dockerfile',
  // Ask about code
  'ask_about_code',
  'cancel_ask_about_code',
  'set_minimax_api_key',
  // System
  'get_system_fonts',
  // File links
  'open_path',
  'read_file_text',
  // Clipboard
  'resolve_clipboard_paste',
  'save_dropped_image',
  // Notifications
  'show_notification',
  'notification_clicked',
  // PR CI status
  'start_pr_checks_watcher',
  'stop_pr_checks_watcher',
  'pr_checks_update',
  // Logging
  'log_from_renderer',
  // Auto-update
  'check_for_updates',
  'download_update',
  'quit_and_install_update',
  'get_update_status',
  'update_status_changed',
  // MCP / Coordinating agent
  'set_coordinator_mode_enabled',
  'start_mcp_server',
  'stop_mcp_server',
  'get_mcp_status',
  'get_mcp_logs',
  'mcp_task_created',
  'mcp_task_closed',
  'mcp_task_state_sync',
  'mcp_control_changed',
  'mcp_coordinator_notification_staged',
  'mcp_coordinator_notification_cleared',
  'mcp_coordinator_orphaned_notification',
  'mcp_coordinator_registered',
  'mcp_coordinator_deregistered',
  'mcp_coordinator_notification_ack',
  'mcp_coordinator_notification_drop_ack',
  'mcp_coordinated_task_prompt_delivered',
  'mcp_coordinator_restage_after_user_send',
  'mcp_hydrate_coordinated_task',
  'mcp_task_hydrated',
  'mcp_stale_url_warning',
  'mcp_coordinated_task_closed',
  'mcp_task_cleanup_failed',
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
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
  // Returns the absolute filesystem path for a File obtained from a drop event
  // (or any DataTransfer / input[type=file]). Returns '' for File objects that
  // have no backing path (e.g. images dragged from a browser tab).
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
});
